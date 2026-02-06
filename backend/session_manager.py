import json
import time
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional


class SessionManager:
    """Global session manager (no projects)."""

    def __init__(self, workspace_root: Path):
        self.workspace_root = Path(workspace_root)
        self.sessions_dir = self.workspace_root / "sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.current_session_id: Optional[str] = None
        self.current_session_path: Optional[Path] = None
        self.start_new_session()

    def start_new_session(self, session_id: Optional[str] = None) -> str:
        ts = datetime.now()
        if not session_id:
            session_id = f"sess_{ts.strftime('%Y%m%d_%H%M%S')}"

        day_dir = self.sessions_dir / ts.strftime("%Y-%m-%d")
        day_dir.mkdir(parents=True, exist_ok=True)

        session_path = day_dir / session_id
        session_path.mkdir(parents=True, exist_ok=True)

        self.current_session_id = session_id
        self.current_session_path = session_path
        self._ensure_meta(ts)
        return session_id

    def _ensure_meta(self, ts: datetime) -> None:
        if not self.current_session_path:
            return
        meta_path = self.current_session_path / "meta.json"
        if meta_path.exists():
            return
        payload = {
            "session_id": self.current_session_id,
            "started_at": ts.astimezone().isoformat(timespec="seconds"),
        }
        meta_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def get_current_session_id(self) -> Optional[str]:
        return self.current_session_id

    def get_current_session_path(self) -> Optional[Path]:
        return self.current_session_path

    def get_session_path(self, session_id: str) -> Optional[Path]:
        if not session_id:
            return None
        if self.current_session_id == session_id and self.current_session_path:
            return self.current_session_path
        # Search on disk
        for day_dir in sorted(self.sessions_dir.iterdir(), reverse=True):
            if not day_dir.is_dir():
                continue
            for sess_dir in sorted(day_dir.iterdir(), reverse=True):
                if sess_dir.is_dir() and sess_dir.name == session_id:
                    return sess_dir
        return None

    def log_chat(self, sender: str, text: str) -> None:
        if not self.current_session_path:
            return
        entry = {
            "timestamp": time.time(),
            "sender": sender,
            "text": text,
            "session_id": self.current_session_id,
        }
        log_file = self.current_session_path / "turns.jsonl"
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def get_recent_chat_history(self, limit: int = 10) -> List[Dict]:
        """Return last N messages across recent sessions (newest first)."""
        results: List[Dict] = []
        for turns_path in self._iter_turns_files_desc():
            try:
                lines = turns_path.read_text(encoding="utf-8", errors="ignore").splitlines()
            except Exception:
                continue

            for line in reversed(lines):
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                    results.append(entry)
                    if len(results) >= limit:
                        return list(reversed(results))
                except Exception:
                    continue

        return list(reversed(results))

    def _iter_turns_files_desc(self):
        if not self.sessions_dir.exists():
            return []

        day_dirs = [d for d in self.sessions_dir.iterdir() if d.is_dir()]
        day_dirs.sort(reverse=True)

        for day_dir in day_dirs:
            sess_dirs = [d for d in day_dir.iterdir() if d.is_dir()]
            sess_dirs.sort(reverse=True)
            for sess_dir in sess_dirs:
                turns = sess_dir / "turns.jsonl"
                if turns.exists():
                    yield turns

