import time
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Tuple


@dataclass
class StudyPageState:
    payload: Optional[Dict[str, Any]] = None
    ts: float = 0.0
    meta: Dict[str, Any] = field(default_factory=dict)


class StudyReader:
    """
    Holds the latest study page context (image + text) for reliable page reading.
    Separated module to keep study-vision logic isolated from server routing.
    """

    def __init__(self):
        self._latest_image = StudyPageState()
        self._latest_text = StudyPageState()
        self._latest_tiles = StudyPageState()

    def update_page_image(
        self,
        *,
        payload: Dict[str, Any],
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not payload:
            return
        self._latest_image.payload = payload
        self._latest_image.ts = time.time()
        self._latest_image.meta = meta or {}

    def update_page_text(
        self,
        *,
        text: str,
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if text is None:
            return
        self._latest_text.payload = {"text": text}
        self._latest_text.ts = time.time()
        self._latest_text.meta = meta or {}

    def get_latest_image(self, max_age_sec: float = 45.0) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        state = self._latest_image
        if not state.payload:
            return None, {}
        if max_age_sec and (time.time() - state.ts) > max_age_sec:
            return None, {}
        return state.payload, dict(state.meta or {})

    def get_latest_text(self, max_age_sec: float = 45.0) -> Tuple[Optional[str], Dict[str, Any]]:
        state = self._latest_text
        if not state.payload:
            return None, {}
        if max_age_sec and (time.time() - state.ts) > max_age_sec:
            return None, {}
        return state.payload.get("text"), dict(state.meta or {})

    def update_page_tiles(
        self,
        *,
        payloads: Optional[list],
        meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not payloads:
            return
        self._latest_tiles.payload = {"tiles": payloads}
        self._latest_tiles.ts = time.time()
        self._latest_tiles.meta = meta or {}

    def get_latest_tiles(self, max_age_sec: float = 45.0) -> Tuple[Optional[list], Dict[str, Any]]:
        state = self._latest_tiles
        if not state.payload:
            return None, {}
        if max_age_sec and (time.time() - state.ts) > max_age_sec:
            return None, {}
        return state.payload.get("tiles"), dict(state.meta or {})
