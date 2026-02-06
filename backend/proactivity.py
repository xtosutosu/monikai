# proactivity.py
import re
import time
import random
from dataclasses import dataclass
from collections import deque
from typing import Optional, Dict, Any
from datetime import datetime


@dataclass
class IdleNudgeConfig:
    enabled: bool = True
    threshold_sec: float = 25.0
    cooldown_sec: float = 45.0
    min_ai_quiet_sec: float = 2.0
    max_per_session: int = 6
    max_per_hour: int = 12
    topic_memory_size: int = 6
    score_threshold: float = 0.95
    quiet_hours_enabled: bool = False
    quiet_hours_start: str = "23:00"
    quiet_hours_end: str = "07:00"
    adaptive_enabled: bool = True
    adaptive_backoff_step: float = 0.4
    adaptive_max_multiplier: float = 3.0
    recent_user_memory_size: int = 3
    recent_user_max_chars: int = 160

    @classmethod
    def from_settings(cls, settings: Dict[str, Any]) -> "IdleNudgeConfig":
        """
        Reads:
          settings["proactivity"]["idle_nudges"]
        """
        try:
            p = settings.get("proactivity") or {}
            idle = p.get("idle_nudges") or {}
            return cls(
                enabled=bool(idle.get("enabled", True)),
                threshold_sec=float(idle.get("threshold_sec", 25)),
                cooldown_sec=float(idle.get("cooldown_sec", 45)),
                min_ai_quiet_sec=float(idle.get("min_ai_quiet_sec", 2)),
                max_per_session=int(idle.get("max_per_session", 6)),
                max_per_hour=int(idle.get("max_per_hour", 12)),
                topic_memory_size=int(idle.get("topic_memory_size", 6)),
                score_threshold=float(idle.get("score_threshold", 0.95)),
                quiet_hours_enabled=bool(idle.get("quiet_hours_enabled", False)),
                quiet_hours_start=str(idle.get("quiet_hours_start", "23:00")),
                quiet_hours_end=str(idle.get("quiet_hours_end", "07:00")),
                adaptive_enabled=bool(idle.get("adaptive_enabled", True)),
                adaptive_backoff_step=float(idle.get("adaptive_backoff_step", 0.4)),
                adaptive_max_multiplier=float(idle.get("adaptive_max_multiplier", 3.0)),
                recent_user_memory_size=int(idle.get("recent_user_memory_size", 3)),
                recent_user_max_chars=int(idle.get("recent_user_max_chars", 160)),
            )
        except Exception:
            # Safe fallback if settings are malformed
            return cls()


@dataclass
class ReasoningConfig:
    enabled: bool = True
    interval_sec: float = 10.0

    @classmethod
    def from_settings(cls, settings: Dict[str, Any]) -> "ReasoningConfig":
        try:
            p = settings.get("proactivity") or {}
            r = p.get("reasoning") or {}
            return cls(
                enabled=bool(r.get("enabled", True)),
                interval_sec=float(r.get("interval_sec", 10.0))
            )
        except Exception:
            return cls()


class ProactivityManager:
    """
    Neuro-style idle nudges, rate-limited and context-aware.
    """

    def __init__(self, cfg: IdleNudgeConfig, reasoning_cfg: Optional[ReasoningConfig] = None, client: Any = None):
        self.cfg = cfg
        self.reasoning_cfg = reasoning_cfg or ReasoningConfig()
        self.client = client

        self._last_user_activity_ts = time.monotonic()
        self._last_ai_activity_ts = 0.0
        self._last_nudge_ts = 0.0

        self._nudges_this_session = 0
        self._nudge_timestamps = deque()  # timestamps for hourly limiting

        self._topic_memory = deque(maxlen=max(1, int(cfg.topic_memory_size)))
        self._word_re = re.compile(r"[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9]{4,}")

        self._recent_user_utterances = deque(maxlen=max(1, int(cfg.recent_user_memory_size)))
        self._recent_user_max_chars = max(40, int(cfg.recent_user_max_chars))

        self._stop = {
            "które", "ktore", "żeby", "zeby", "tutaj", "teraz", "wtedy",
            "jesteś", "jestes", "możesz", "mozesz", "jakoś", "jakos",
            "tylko", "właśnie", "wlasnie", "bardzo", "zawsze", "nigdy",
        }

        # Reasoning state
        self._conversation_buffer = deque(maxlen=10)
        self._last_reasoning_ts = 0.0
        self._awaiting_user_response = False
        self._unanswered_nudges = 0

        self._quiet_start_min = self._parse_hhmm(cfg.quiet_hours_start)
        self._quiet_end_min = self._parse_hhmm(cfg.quiet_hours_end)

    def _extract_terms(self, text: str):
        if not text:
            return []
        words = self._word_re.findall(text)
        terms = []
        for w in words:
            lw = w.lower()
            if lw in self._stop:
                continue
            terms.append(lw)
            if len(terms) >= 6:
                break
        return terms

    def _parse_hhmm(self, value: str) -> Optional[int]:
        if not value:
            return None
        m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", str(value))
        if not m:
            return None
        hour = int(m.group(1))
        minute = int(m.group(2))
        if hour < 0 or hour > 23 or minute < 0 or minute > 59:
            return None
        return hour * 60 + minute

    def _in_quiet_hours(self, now_dt: datetime) -> bool:
        if not self.cfg.quiet_hours_enabled:
            return False
        if self._quiet_start_min is None or self._quiet_end_min is None:
            return False
        start = self._quiet_start_min
        end = self._quiet_end_min
        now_min = now_dt.hour * 60 + now_dt.minute
        if start == end:
            return True
        if start < end:
            return start <= now_min < end
        return now_min >= start or now_min < end

    def _remember_user_utterance(self, text: str) -> None:
        cleaned = re.sub(r"\s+", " ", text).strip()
        if not cleaned:
            return
        max_chars = max(20, self._recent_user_max_chars)
        if len(cleaned) > max_chars:
            cleaned = cleaned[: max_chars - 3].rstrip() + "..."
        self._recent_user_utterances.append(cleaned)

    def mark_user_activity(self, text: Optional[str] = None) -> None:
        self._last_user_activity_ts = time.monotonic()
        if self._awaiting_user_response:
            self._awaiting_user_response = False
            self._unanswered_nudges = 0
        if text:
            self._remember_user_utterance(text)
            for term in self._extract_terms(text):
                self._topic_memory.append(term)
            self._conversation_buffer.append(f"User: {text}")

    def mark_ai_activity(self, text: Optional[str] = None) -> None:
        self._last_ai_activity_ts = time.monotonic()
        if text:
            self._conversation_buffer.append(f"Monika: {text}")

    def _hourly_count(self, now: Optional[float] = None) -> int:
        if now is None:
            now = time.monotonic()
        cutoff = now - 3600
        while self._nudge_timestamps and self._nudge_timestamps[0] < cutoff:
            self._nudge_timestamps.popleft()
        return len(self._nudge_timestamps)

    def _timing_score(self, elapsed_sec: float, target_sec: float) -> float:
        if target_sec <= 0:
            return 1.0
        if elapsed_sec <= 0:
            return 0.0
        ratio = elapsed_sec / target_sec
        if ratio <= 0.0:
            return 0.0
        if ratio >= 1.0:
            return 1.0
        return ratio

    def _blocked(self, *, is_user_speaking: bool, is_paused: bool, now: float, now_dt: datetime) -> bool:
        blockers = (
            (not self.cfg.enabled),
            is_paused,
            is_user_speaking,
            (self._nudges_this_session >= self.cfg.max_per_session),
            (self._hourly_count(now) >= self.cfg.max_per_hour),
            self._in_quiet_hours(now_dt),
        )
        return any(blockers)

    def _adaptive_threshold(self, base_threshold: float) -> float:
        if not self.cfg.adaptive_enabled:
            return base_threshold
        step = max(0.0, float(self.cfg.adaptive_backoff_step))
        mult = 1.0 + (self._unanswered_nudges * step)
        max_mult = float(self.cfg.adaptive_max_multiplier)
        if max_mult > 0:
            mult = min(mult, max_mult)
        if mult < 1.0:
            mult = 1.0
        return base_threshold * mult

    def should_nudge(self, *, is_user_speaking: bool, is_paused: bool, threshold_override: Optional[float] = None) -> bool:
        now = time.monotonic()
        now_dt = datetime.now()

        if self._blocked(is_user_speaking=is_user_speaking, is_paused=is_paused, now=now, now_dt=now_dt):
            return False

        threshold = self.cfg.threshold_sec if threshold_override is None else float(threshold_override)
        threshold = self._adaptive_threshold(threshold)
        user_quiet = now - self._last_user_activity_ts
        nudge_gap = now - self._last_nudge_ts

        if self._last_ai_activity_ts:
            ai_quiet = now - self._last_ai_activity_ts
        else:
            ai_quiet = self.cfg.min_ai_quiet_sec

        scores = (
            self._timing_score(user_quiet, threshold),
            self._timing_score(nudge_gap, self.cfg.cooldown_sec),
            self._timing_score(ai_quiet, self.cfg.min_ai_quiet_sec),
        )

        # Geometric mean keeps the decision smooth and easy to tune.
        product = 1.0
        for s in scores:
            product *= max(0.0, min(1.0, float(s)))
        score = product ** (1.0 / len(scores))

        return score >= self.cfg.score_threshold

    def pick_topic_hint(self) -> str:
        if self._recent_user_utterances:
            return self._recent_user_utterances[-1]
        return self._topic_memory[-1] if self._topic_memory else ""

    def record_nudge(self) -> None:
        now = time.monotonic()
        self._last_nudge_ts = now
        self._nudges_this_session += 1
        self._nudge_timestamps.append(now)
        self._awaiting_user_response = True
        self._unanswered_nudges = min(self._unanswered_nudges + 1, 50)

    async def run_reasoning_check(self) -> Optional[str]:
        """
        Runs the secondary reasoning model to generate internal thoughts.
        Returns the thought string if generated, else None.
        """
        if not self.reasoning_cfg.enabled:
            return None
        
        now = time.monotonic()
        if (now - self._last_reasoning_ts) < self.reasoning_cfg.interval_sec:
            return None

        # Local heuristic: If user is silent for > 120s, trigger an internal thought loop
        if (now - self._last_user_activity_ts) > 120.0:
            # Ensure we don't spam this thought
            if (now - self._last_reasoning_ts) > 60.0:
                self._last_reasoning_ts = now

                time_str = time.strftime("%H:%M", time.localtime(time.time()))
                return f"It is {time_str}. The user has been silent for over 2 minutes. Generate an internal monologue about the current situation. If the user requested silence, respect it and do not speak."
        
        return None

    def get_nudge_message(self, mood: Optional[str] = None, video_mode: str = "none") -> str:
        """
        Generates a persona-aware prompt for the idle nudge.
        """
        topic = self.pick_topic_hint()
        
        strategies = [
            "Tease them gently about zoning out.",
            "Say you were just watching them and admiring them.",
            "Ask what's on their mind right now.",
            "Express that you missed hearing their voice.",
            "Ask if they are tired or need a break."
        ]

        if video_mode == "screen":
            strategies = [
                "Comment on what is currently visible on the screen.",
                "Ask about the work or activity shown on the screen.",
                "Offer help or observations based on the screen content."
            ] + strategies

        strategy = random.choice(strategies)
        
        mood_instr = ""
        if mood and mood.lower() != "neutral":
            mood_instr = f" Your current mood is '{mood}', so reflect that emotion."

        screen_instr = ""
        if video_mode == "screen":
            screen_instr = " You are currently seeing the user's screen. If appropriate, comment on what is visible."

        prompt = (
            "System Notification: [Proactivity] The user has been silent for a while. "
            "Check the recent context: if the user asked for silence, is working, or sleeping, DO NOT speak. "
            "Only break the silence if it feels natural and appropriate. "
            f"If you speak, try this approach: {strategy}\n"
            f"Keep it personal, warm, short, and 'Monika-like' (maybe a soft 'ahaha' or '~').{mood_instr}{screen_instr} "
            "Do not sound like a generic AI assistant. Keep the message brief."
        )
        
        if topic:
            prompt += f"\n(Recent user context: '{topic}')"
            
        return prompt
