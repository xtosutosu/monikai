# proactivity.py
import re
import time
import random
from dataclasses import dataclass
from collections import deque
from typing import Optional, Dict, Any


@dataclass
class IdleNudgeConfig:
    enabled: bool = True
    threshold_sec: float = 25.0
    cooldown_sec: float = 45.0
    min_ai_quiet_sec: float = 2.0
    max_per_session: int = 6
    max_per_hour: int = 12
    topic_memory_size: int = 6

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

        self._last_user_activity_ts = time.time()
        self._last_ai_activity_ts = 0.0
        self._last_nudge_ts = 0.0

        self._nudges_this_session = 0
        self._nudge_timestamps = deque()  # timestamps for hourly limiting

        self._topic_memory = deque(maxlen=max(1, int(cfg.topic_memory_size)))
        self._word_re = re.compile(r"[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9]{4,}")

        self._stop = {
            "które", "ktore", "żeby", "zeby", "tutaj", "teraz", "wtedy",
            "jesteś", "jestes", "możesz", "mozesz", "jakoś", "jakos",
            "tylko", "właśnie", "wlasnie", "bardzo", "zawsze", "nigdy",
        }

        # Reasoning state
        self._conversation_buffer = deque(maxlen=10)
        self._last_reasoning_ts = 0.0

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

    def mark_user_activity(self, text: Optional[str] = None) -> None:
        self._last_user_activity_ts = time.time()
        if text:
            for term in self._extract_terms(text):
                self._topic_memory.append(term)
            self._conversation_buffer.append(f"User: {text}")

    def mark_ai_activity(self, text: Optional[str] = None) -> None:
        self._last_ai_activity_ts = time.time()
        if text:
            self._conversation_buffer.append(f"Monika: {text}")

    def _hourly_count(self) -> int:
        now = time.time()
        cutoff = now - 3600
        while self._nudge_timestamps and self._nudge_timestamps[0] < cutoff:
            self._nudge_timestamps.popleft()
        return len(self._nudge_timestamps)

    def should_nudge(self, *, is_user_speaking: bool, is_paused: bool, threshold_override: Optional[float] = None) -> bool:
        if not self.cfg.enabled:
            return False
        if is_paused:
            return False
        if is_user_speaking:
            return False

        now = time.time()
        
        threshold = self.cfg.threshold_sec
        if threshold_override is not None:
            threshold = threshold_override

        # user must be quiet long enough
        if (now - self._last_user_activity_ts) < threshold:
            return False

        # cooldown between nudges
        if (now - self._last_nudge_ts) < self.cfg.cooldown_sec:
            return False

        # avoid nudging immediately after AI spoke
        if self._last_ai_activity_ts and (now - self._last_ai_activity_ts) < self.cfg.min_ai_quiet_sec:
            return False

        # session limit
        if self._nudges_this_session >= self.cfg.max_per_session:
            return False

        # hourly limit
        if self._hourly_count() >= self.cfg.max_per_hour:
            return False

        return True

    def pick_topic_hint(self) -> str:
        return self._topic_memory[-1] if self._topic_memory else ""

    def record_nudge(self) -> None:
        now = time.time()
        self._last_nudge_ts = now
        self._nudges_this_session += 1
        self._nudge_timestamps.append(now)

    async def run_reasoning_check(self) -> Optional[str]:
        """
        Runs the secondary reasoning model to generate internal thoughts.
        Returns the thought string if generated, else None.
        """
        if not self.reasoning_cfg.enabled:
            return None
        
        now = time.time()
        if (now - self._last_reasoning_ts) < self.reasoning_cfg.interval_sec:
            return None

        # Local heuristic: If user is silent for > 120s, trigger an internal thought loop
        if (now - self._last_user_activity_ts) > 120.0:
            # Ensure we don't spam this thought
            if (now - self._last_reasoning_ts) > 60.0:
                self._last_reasoning_ts = now
                
                time_str = time.strftime("%H:%M", time.localtime(now))
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
            prompt += f"\n(Recent topic context: '{topic}')"
            
        return prompt
