# proactivity.py
import re
import time
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


class ProactivityManager:
    """
    Neuro-style idle nudges, rate-limited and context-aware.
    """

    def __init__(self, cfg: IdleNudgeConfig):
        self.cfg = cfg

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

    def mark_ai_activity(self) -> None:
        self._last_ai_activity_ts = time.time()

    def _hourly_count(self) -> int:
        now = time.time()
        cutoff = now - 3600
        while self._nudge_timestamps and self._nudge_timestamps[0] < cutoff:
            self._nudge_timestamps.popleft()
        return len(self._nudge_timestamps)

    def should_nudge(self, *, is_user_speaking: bool, is_paused: bool) -> bool:
        if not self.cfg.enabled:
            return False
        if is_paused:
            return False
        if is_user_speaking:
            return False

        now = time.time()

        # user must be quiet long enough
        if (now - self._last_user_activity_ts) < self.cfg.threshold_sec:
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
