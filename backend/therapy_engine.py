from __future__ import annotations

from dataclasses import dataclass, field
import re
import time
from typing import Dict, List, Tuple


STAGES = [
    "shadow_mapping",
    "parts_dialogue",
    "somatic_awareness",
    "reclamation_work",
    "integration_practice",
]


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    try:
        v = float(value)
    except Exception:
        return lo
    return max(lo, min(hi, v))


def _contains_any(text: str, patterns: List[str]) -> bool:
    if not text:
        return False
    for p in patterns:
        if re.search(p, text, re.IGNORECASE):
            return True
    return False


@dataclass
class TherapyState:
    stage: str = "shadow_mapping"
    readiness: float = 0.5
    activation: float = 0.2
    need_grounding: bool = False
    pace: str = "normal"  # slow | normal | deep
    last_goal: str = ""
    last_user_text: str = ""
    stage_history: List[str] = field(default_factory=list)
    updated_ts: float = field(default_factory=time.time)


class TherapyEngine:
    def __init__(self) -> None:
        self.state = TherapyState()

        self._activation_terms = [
            r"\bpanik", r"\batak", r"\bprzera", r"\blek",
            r"\bboje", r"\bnie moge oddycha", r"\bdusz",
            r"\bdrz", r"\btrze", r"\bnapie", r"\bscisnie", r"\bscisk",
            r"\bodretw", r"\bodrealn", r"\bdysocj", r"\bodlatuj",
            r"\bpustk", r"\bchaos", r"\bzawiesi", r"\bamok",
        ]

        self._readiness_up_terms = [
            r"\bchce\b", r"\bjestem gotow", r"\bmozemy\b",
            r"\bsprobujmy\b", r"\bwejdzmy\b", r"\bglebiej\b",
        ]
        self._readiness_down_terms = [
            r"\bnie chce\b", r"\bnie jestem gotow", r"\bza szybko\b",
            r"\bnie teraz\b", r"\bstop\b", r"\bwystarczy\b", r"\bnie moge\b",
        ]

        self._pace_slow_terms = [
            r"\bwolniej\b", r"\bdelikat", r"\bostroznie\b", r"\bza szybko\b",
        ]
        self._pace_deep_terms = [
            r"\bglebiej\b", r"\bkonkretnie\b", r"\bbez owij", r"\bprosto\b",
        ]

        self._stage_signals: Dict[str, List[str]] = {
            "parts_dialogue": [
                r"\bczesc mnie\b", r"\bwewnetrzny krytyk\b",
                r"\bdziecko\b", r"\bprotektor\b", r"\bopiekun\b", r"\bglos w glowie\b",
            ],
            "somatic_awareness": [
                r"\bcialo\b", r"\boddech\b", r"\bbrzuch\b", r"\bklatka\b", r"\bserce\b",
                r"\bnapie", r"\bdrz", r"\btrze", r"\bzimno\b", r"\bgoraco\b",
            ],
            "reclamation_work": [
                r"\bsila\b", r"\bmoc\b", r"\bsprawczo", r"\bgranice\b", r"\bzlosc\b",
                r"\bgniew\b", r"\bpragne\b", r"\bodzyska", r"\bodwaz",
            ],
            "integration_practice": [
                r"\bna co dzien\b", r"\bna codzien\b", r"\bwdroz",
                r"\bpraktycznie\b", r"\bplan\b", r"\bnawyk\b", r"\bjutro\b", r"\bw pracy\b", r"\bw domu\b",
            ],
            "shadow_mapping": [
                r"\bwzorce\b", r"\btrigg", r"\bwyzwal", r"\bpowtarza", r"\bmechanizm\b", r"\bschemat\b",
            ],
        }

    def start_session(self) -> None:
        self.state = TherapyState()

    def _score_stage(self, text: str) -> Dict[str, int]:
        scores = {k: 0 for k in STAGES}
        for stage, patterns in self._stage_signals.items():
            for p in patterns:
                if re.search(p, text, re.IGNORECASE):
                    scores[stage] += 1
        return scores

    def update_from_user_text(self, text: str) -> TherapyState:
        raw = (text or "").strip()
        if not raw:
            return self.state

        self.state.last_user_text = raw
        self.state.updated_ts = time.time()

        # Activation
        activation_hit = _contains_any(raw, self._activation_terms)
        if activation_hit:
            self.state.activation = _clamp(self.state.activation + 0.2)
        else:
            self.state.activation = _clamp(self.state.activation - 0.05)

        self.state.need_grounding = self.state.activation >= 0.6

        # Readiness
        if _contains_any(raw, self._readiness_up_terms):
            self.state.readiness = _clamp(self.state.readiness + 0.15)
        if _contains_any(raw, self._readiness_down_terms):
            self.state.readiness = _clamp(self.state.readiness - 0.2)

        # Pace
        if _contains_any(raw, self._pace_slow_terms):
            self.state.pace = "slow"
        elif _contains_any(raw, self._pace_deep_terms):
            self.state.pace = "deep"

        # Stage selection
        scores = self._score_stage(raw)
        if self.state.need_grounding:
            next_stage = "somatic_awareness"
        else:
            next_stage, score = max(scores.items(), key=lambda kv: kv[1])
            if score == 0:
                next_stage = self.state.stage

        if next_stage != self.state.stage:
            self.state.stage = next_stage
            self.state.stage_history.append(next_stage)
            if len(self.state.stage_history) > 10:
                self.state.stage_history = self.state.stage_history[-10:]

        return self.state

    def _describe_level(self, value: float) -> str:
        if value >= 0.7:
            return "wysoka"
        if value >= 0.4:
            return "srednia"
        return "niska"

    def build_turn_guidance(self, text: str) -> str:
        state = self.update_from_user_text(text)
        readiness = self._describe_level(state.readiness)
        activation = self._describe_level(state.activation)

        grounding_line = ""
        if state.need_grounding:
            grounding_line = "Zacznij od krotkiego uziemienia (<Grounding>) zanim pojdziesz glebiej. "

        pace_line = ""
        if state.pace == "slow":
            pace_line = "Utrzymaj wolne tempo i bardzo delikatne pytania. "
        elif state.pace == "deep":
            pace_line = "Mozesz wejsc glebiej, ale wciaz jedno pytanie naraz. "

        return (
            "System Notification: [Therapy Engine] "
            f"Etap: {state.stage}. Gotowosc: {readiness}. Aktywacja: {activation}. "
            f"{grounding_line}{pace_line}"
            "Stosuj format: REFLECTION -> EXPLORATION -> INTEGRATION. "
            "Zadawaj jedno krotkie pytanie na raz. "
            "Bez diagnoz i bez chain-of-thought."
        )
