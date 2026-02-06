import json
import re
import sqlite3
import hashlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class MemoryEntry:
    id: str
    type: str
    content: str
    tags: List[str]
    entities: List[str]
    origin: str
    confidence: float
    stability: str
    status: str
    created_at: str
    updated_at: str
    source: Dict[str, Any]
    data: Dict[str, Any]


class MemoryEngine:
    """Global memory engine with JSONL + SQLite FTS index and markdown pages."""

    def __init__(
        self,
        base_dir: Path,
        session_manager=None,
        emit_event=None,
        language: str = "pl",
    ):
        self.base_dir = Path(base_dir).resolve()
        self.session_manager = session_manager
        self.emit_event = emit_event
        self.language = language

        self.memory_dir = self.base_dir / "memory"
        self.pages_dir = self.memory_dir / "pages"
        self.entries_path = self.memory_dir / "entries.jsonl"
        self.index_dir = self.memory_dir / "index"
        self.db_path = self.index_dir / "memory.db"

        self._init_language_config()
        self.bootstrap()

    # ------------------------------------------------------------------
    # Bootstrap
    # ------------------------------------------------------------------
    def bootstrap(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.pages_dir.mkdir(parents=True, exist_ok=True)
        self.index_dir.mkdir(parents=True, exist_ok=True)

        if not self.entries_path.exists():
            self.entries_path.write_text("", encoding="utf-8")

        self._ensure_schema()

        # Prepare folders for future features (roleplay, learning, shadow work)
        for sub in ["journal", "topics", "roleplay", "learning", "shadow_work"]:
            (self.pages_dir / sub).mkdir(parents=True, exist_ok=True)

        notes_path = self.pages_dir / "notes.md"
        if not notes_path.exists():
            notes_path.write_text("# Notes (Global)\n\n", encoding="utf-8")

    # ------------------------------------------------------------------
    # Language config (light heuristics)
    # ------------------------------------------------------------------
    def _init_language_config(self) -> None:
        self.LANG_CONFIG = {
            "pl": {
                "name_re": re.compile(
                    r"(?:nazywam\s+się|mam\s+na\s+imię|moje\s+imię\s+to|imię\s+to|jestem\s+tu\s+jako|to\s+ja)\s+"
                    r"([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{1,30})",
                    re.IGNORECASE,
                ),
                "name_re2": re.compile(
                    r"\bjestem\s+([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{1,30})"
                    r"(?!\s*(?:ok|okej|dobrze|gotowy|spoko|szczęśliwy|szczesliwy|zmęczony|zmeczony|głodny|glodny|"
                    r"zajęty|zajety|chory))",
                    re.IGNORECASE,
                ),
                "date_re": re.compile(r"\b(\d{1,2})[\./-](\d{1,2})[\./-](\d{4})\b"),
                "pref_re": re.compile(
                    r"\b(?:wolę|wole|preferuję|preferuje|lubię|lubie|nie lubię|nie lubie|nie chcę|nie chce)\b",
                    re.IGNORECASE,
                ),
                "routine_re": re.compile(
                    r"\b(?:codziennie|zwykle|najczęściej|najczesciej|rano|wieczorem|w weekendy)\b",
                    re.IGNORECASE,
                ),
                "dob_keywords": ["urodzi", "urodzin", "data urod"],
                "context_keywords": ["mam", "mój", "moja", "moje", "pracuję", "pracuje", "robię", "robie", "chciałbym", "chcialbym"],
                "single_token_name_re": re.compile(r"[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{1,30}"),
            },
            "en": {
                "name_re": re.compile(
                    r"(?:my\s+name\s+is|i'm\s+called|i\s+am|call\s+me)\s+"
                    r"([A-Za-z][A-Za-z\-]{1,30})",
                    re.IGNORECASE,
                ),
                "name_re2": re.compile(
                    r"\bi'm\s+([A-Za-z][A-Za-z\-]{1,30})"
                    r"(?!\s*(?:ok|okay|good|ready|happy|tired|hungry|busy|sick))",
                    re.IGNORECASE,
                ),
                "date_re": re.compile(r"\b(\d{1,2})[\./-](\d{1,2})[\./-](\d{4})\b"),
                "pref_re": re.compile(
                    r"\b(?:i\s+prefer|i\s+like|i\s+don't\s+like|i\s+do\s+not\s+like|i\s+want|i\s+don't\s+want)\b",
                    re.IGNORECASE,
                ),
                "routine_re": re.compile(
                    r"\b(?:every\s+day|usually|often|in\s+the\s+morning|in\s+the\s+evening|on\s+weekends)\b",
                    re.IGNORECASE,
                ),
                "dob_keywords": ["born", "birthday", "date of birth"],
                "context_keywords": ["i have", "my", "i work", "i do", "i'd like", "i would like"],
                "single_token_name_re": re.compile(r"[A-Z][a-z]{1,30}"),
            },
        }

        config = self.LANG_CONFIG.get(self.language, self.LANG_CONFIG["pl"])
        self._name_re = config["name_re"]
        self._name_re2 = config["name_re2"]
        self._date_re = config["date_re"]
        self._pref_re = config["pref_re"]
        self._routine_re = config["routine_re"]
        self._dob_keywords = config["dob_keywords"]
        self._context_keywords = config["context_keywords"]
        self._single_token_name_re = config["single_token_name_re"]
        self._date_iso_re = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")

    # ------------------------------------------------------------------
    # DB
    # ------------------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS entries (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tags TEXT,
                    tags_text TEXT,
                    entities TEXT,
                    entities_text TEXT,
                    origin TEXT,
                    confidence REAL,
                    stability TEXT,
                    status TEXT,
                    created_at TEXT,
                    updated_at TEXT,
                    source TEXT,
                    data TEXT,
                    hash TEXT
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries(hash)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status)")
            conn.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
                    content,
                    tags,
                    entities,
                    content='entries',
                    content_rowid='rowid'
                )
                """
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _iso_now(self) -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")

    def _emit(self, payload: Dict[str, Any]) -> None:
        if not self.emit_event:
            return
        try:
            self.emit_event(payload)
        except Exception:
            pass

    def _slugify(self, text: str) -> str:
        s = (text or "").strip().lower()
        s = re.sub(r"[^a-z0-9\-_\s]+", "", s)
        s = re.sub(r"\s+", "_", s)
        return s[:64] if s else "page"

    def _hash_entry(self, type_: str, content: str, entities: List[str]) -> str:
        key = f"{type_}|{content.strip().lower()}|{'|'.join(sorted(e.lower() for e in entities))}"
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def _tags_text(self, tags: List[str]) -> str:
        return " ".join([t.strip().lower() for t in tags if t and str(t).strip()])

    def _entities_text(self, entities: List[str]) -> str:
        return " ".join([e.strip().lower() for e in entities if e and str(e).strip()])

    def _normalize_tags(self, tags: Optional[List[str]]) -> List[str]:
        if not tags:
            return []
        out = []
        for t in tags:
            if not t:
                continue
            tt = str(t).strip()
            if not tt:
                continue
            out.append(tt)
        return list(dict.fromkeys(out))

    def _normalize_entities(self, entities: Optional[List[str]]) -> List[str]:
        if not entities:
            return []
        out = []
        for e in entities:
            if not e:
                continue
            ee = str(e).strip()
            if not ee:
                continue
            out.append(ee)
        return list(dict.fromkeys(out))

    def _write_jsonl(self, payload: Dict[str, Any]) -> None:
        with self.entries_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def _sanitize_query(self, query: str) -> str:
        tokens = re.findall(r"[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż]+", query or "")
        return " AND ".join(tokens) if tokens else ""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def add_entry(
        self,
        type: str,
        content: str,
        tags: Optional[List[str]] = None,
        entities: Optional[List[str]] = None,
        origin: str = "real",
        confidence: float = 0.6,
        stability: str = "medium",
        status: str = "active",
        source: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Tuple[str, str]:
        if not content or not str(content).strip():
            raise ValueError("content is required")

        tags = self._normalize_tags(tags)
        entities = self._normalize_entities(entities)

        now = self._iso_now()
        source = source or {}
        data = data or {}

        if self.session_manager and not source.get("session_id"):
            source["session_id"] = self.session_manager.get_current_session_id()

        entry_hash = self._hash_entry(type, content, entities)

        with self._connect() as conn:
            existing = conn.execute(
                "SELECT id FROM entries WHERE hash = ? AND type = ? AND status = 'active'",
                (entry_hash, type),
            ).fetchone()
            if existing:
                return existing["id"], "dedup"

            entry_id = f"mem_{hashlib.sha1((entry_hash + now).encode('utf-8')).hexdigest()[:16]}"
            tags_text = self._tags_text(tags)
            entities_text = self._entities_text(entities)

            conn.execute(
                """
                INSERT INTO entries (
                    id, type, content, tags, tags_text, entities, entities_text,
                    origin, confidence, stability, status, created_at, updated_at, source, data, hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id,
                    type,
                    content,
                    json.dumps(tags, ensure_ascii=False),
                    tags_text,
                    json.dumps(entities, ensure_ascii=False),
                    entities_text,
                    origin,
                    float(confidence),
                    stability,
                    status,
                    now,
                    now,
                    json.dumps(source, ensure_ascii=False),
                    json.dumps(data, ensure_ascii=False),
                    entry_hash,
                ),
            )

            row = conn.execute("SELECT rowid FROM entries WHERE id = ?", (entry_id,)).fetchone()
            if row:
                conn.execute(
                    "INSERT INTO entries_fts(rowid, content, tags, entities) VALUES (?, ?, ?, ?)",
                    (row["rowid"], content, tags_text, entities_text),
                )

        self._write_jsonl({
            "op": "add",
            "entry": {
                "id": entry_id,
                "type": type,
                "content": content,
                "tags": tags,
                "entities": entities,
                "origin": origin,
                "confidence": confidence,
                "stability": stability,
                "status": status,
                "created_at": now,
                "updated_at": now,
                "source": source,
                "data": data,
            },
        })

        self._emit({"kind": "memory_add", "id": entry_id, "type": type})
        return entry_id, "ok"

    def update_entry(self, entry_id: str, fields: Dict[str, Any]) -> str:
        if not entry_id:
            raise ValueError("entry_id required")
        if not fields:
            return "no-op"

        with self._connect() as conn:
            row = conn.execute("SELECT rowid, content, tags_text, entities_text FROM entries WHERE id = ?", (entry_id,)).fetchone()
            if not row:
                return "not-found"

            updates = []
            params = []

            if "content" in fields:
                updates.append("content = ?")
                params.append(fields["content"])

            if "tags" in fields:
                tags = self._normalize_tags(fields["tags"])
                updates.append("tags = ?")
                params.append(json.dumps(tags, ensure_ascii=False))
                updates.append("tags_text = ?")
                params.append(self._tags_text(tags))

            if "entities" in fields:
                entities = self._normalize_entities(fields["entities"])
                updates.append("entities = ?")
                params.append(json.dumps(entities, ensure_ascii=False))
                updates.append("entities_text = ?")
                params.append(self._entities_text(entities))

            for key in ["origin", "confidence", "stability", "status", "source", "data"]:
                if key in fields:
                    val = fields[key]
                    if key in ("source", "data"):
                        val = json.dumps(val or {}, ensure_ascii=False)
                    updates.append(f"{key} = ?")
                    params.append(val)

            updates.append("updated_at = ?")
            params.append(self._iso_now())

            if not updates:
                return "no-op"

            params.append(entry_id)
            conn.execute(f"UPDATE entries SET {', '.join(updates)} WHERE id = ?", params)

            content = fields.get("content", row["content"])
            tags_text = self._tags_text(fields.get("tags", [])) if "tags" in fields else row["tags_text"]
            entities_text = self._entities_text(fields.get("entities", [])) if "entities" in fields else row["entities_text"]
            conn.execute("DELETE FROM entries_fts WHERE rowid = ?", (row["rowid"],))
            conn.execute(
                "INSERT INTO entries_fts(rowid, content, tags, entities) VALUES (?, ?, ?, ?)",
                (row["rowid"], content, tags_text, entities_text),
            )

        self._write_jsonl({"op": "update", "id": entry_id, "fields": fields})
        self._emit({"kind": "memory_update", "id": entry_id})
        return "ok"

    def search(self, query: str, types: Optional[List[str]] = None, tags: Optional[List[str]] = None, limit: int = 5) -> List[Dict[str, Any]]:
        q = self._sanitize_query(query)
        if not q:
            return []

        types = self._normalize_tags(types)
        tags = self._normalize_tags(tags)

        sql = (
            "SELECT e.*, bm25(entries_fts) AS rank "
            "FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid "
            "WHERE entries_fts MATCH ? AND e.status = 'active'"
        )
        params = [q]

        if types:
            sql += " AND e.type IN ({})".format(",".join(["?"] * len(types)))
            params.extend(types)

        if tags:
            for t in tags:
                sql += " AND e.tags_text LIKE ?"
                params.append(f"%{t.lower()}%")

        sql += " ORDER BY rank LIMIT ?"
        params.append(int(limit))

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        return [self._row_to_dict(r) for r in rows]

    def list_recent(self, limit: int = 10, types: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        types = self._normalize_tags(types)
        sql = "SELECT * FROM entries WHERE status = 'active'"
        params = []
        if types:
            sql += " AND type IN ({})".format(",".join(["?"] * len(types)))
            params.extend(types)
        sql += " ORDER BY updated_at DESC LIMIT ?"
        params.append(int(limit))

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "type": row["type"],
            "content": row["content"],
            "tags": json.loads(row["tags"] or "[]"),
            "entities": json.loads(row["entities"] or "[]"),
            "origin": row["origin"],
            "confidence": row["confidence"],
            "stability": row["stability"],
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "source": json.loads(row["source"] or "{}"),
            "data": json.loads(row["data"] or "{}"),
        }

    # ------------------------------------------------------------------
    # Pages
    # ------------------------------------------------------------------
    def create_page(self, title: str, folder: str = "topics", tags: Optional[List[str]] = None) -> str:
        folder = (folder or "topics").strip().lower()
        slug = self._slugify(title)
        tags = self._normalize_tags(tags)

        page_dir = self.pages_dir / folder
        page_dir.mkdir(parents=True, exist_ok=True)
        path = page_dir / f"{slug}.md"

        if not path.exists():
            frontmatter = [
                "---",
                f"id: page_{slug}",
                "type: topic_page",
                f"title: {title}",
                f"tags: [{', '.join(tags)}]" if tags else "tags: []",
                f"created_at: {self._iso_now()}",
                f"updated_at: {self._iso_now()}",
                "---",
                "",
                f"# {title}",
                "",
            ]
            path.write_text("\n".join(frontmatter), encoding="utf-8")

        return str(path)

    def append_page(self, path: str, content: str) -> str:
        if not path:
            raise ValueError("path required")
        p = Path(path)
        if not p.is_absolute():
            p = (self.pages_dir / path).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            if content and not content.startswith("\n"):
                f.write("\n")
            f.write(content)
            if content and not content.endswith("\n"):
                f.write("\n")
        return str(p)

    def get_page(self, path: str) -> str:
        if not path:
            raise ValueError("path required")
        p = Path(path)
        if not p.is_absolute():
            p = (self.pages_dir / path).resolve()
        if not p.exists():
            return ""
        return p.read_text(encoding="utf-8", errors="ignore")

    # ------------------------------------------------------------------
    # Journal
    # ------------------------------------------------------------------
    def journal_add_entry(
        self,
        content: str,
        topics: Optional[List[str]] = None,
        mood: Optional[str] = None,
        session_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> str:
        if not content or not str(content).strip():
            raise ValueError("content required")

        topics = self._normalize_tags(topics)
        tags = self._normalize_tags(tags)
        if topics:
            tags.extend([f"topic:{t}" for t in topics])

        if not session_id and self.session_manager:
            session_id = self.session_manager.get_current_session_id()

        now = datetime.now().astimezone()
        date_key = now.strftime("%Y-%m-%d")
        time_key = now.strftime("%H:%M")

        journal_dir = self.pages_dir / "journal"
        journal_dir.mkdir(parents=True, exist_ok=True)
        journal_path = journal_dir / f"{date_key}.md"

        header = f"## {date_key} {time_key}\n"
        meta = []
        if session_id:
            meta.append(f"- session: {session_id}")
        if mood:
            meta.append(f"- mood: {mood}")
        if topics:
            meta.append(f"- topics: {', '.join(topics)}")
        meta_block = "\n".join(meta)

        block = header
        if meta_block:
            block += meta_block + "\n"
        block += "\n" + content.strip() + "\n"

        if not journal_path.exists():
            journal_path.write_text(f"# Journal ({date_key})\n\n", encoding="utf-8")
        self.append_page(str(journal_path), block)

        entry_id, _ = self.add_entry(
            type="journal",
            content=content.strip(),
            tags=tags,
            entities=["user"],
            origin="real",
            confidence=0.7,
            stability="medium",
            source={"session_id": session_id} if session_id else {},
            data={"mood": mood or ""},
        )
        return entry_id

    def journal_finalize_session(
        self,
        summary: str,
        reflections: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> str:
        if not summary or not str(summary).strip():
            raise ValueError("summary required")

        if not session_id and self.session_manager:
            session_id = self.session_manager.get_current_session_id()

        if not session_id:
            return "no-session"

        session_path = None
        if self.session_manager and hasattr(self.session_manager, "get_session_path"):
            session_path = self.session_manager.get_session_path(session_id)
        if not session_path:
            return "no-session"

        session_path = Path(session_path)
        session_path.mkdir(parents=True, exist_ok=True)
        summary_path = session_path / "summary.md"

        content = [
            f"# Session Summary ({session_id})",
            "",
            summary.strip(),
        ]
        if reflections:
            content.extend(["", "## Reflections", reflections.strip()])

        summary_path.write_text("\n".join(content) + "\n", encoding="utf-8")

        self.add_entry(
            type="reflection",
            content=summary.strip(),
            tags=["session_summary"],
            entities=["user"],
            origin="real",
            confidence=0.6,
            stability="medium",
            source={"session_id": session_id},
            data={"reflections": reflections or ""},
        )

        return "ok"

    # ------------------------------------------------------------------
    # Brief summary for compatibility
    # ------------------------------------------------------------------
    def render_memory_brief(self) -> str:
        lines = ["# Global Memory (brief)", f"_Updated: {self._iso_now()}_", ""]

        facts = self.list_recent(limit=12, types=["fact", "preference", "event"])
        if facts:
            lines.append("## Key Facts / Preferences")
            for f in facts[:12]:
                lines.append(f"- [{f['type']}] {f['content']}")
            lines.append("")

        notes = self.list_recent(limit=8, types=["memory_note"])
        if notes:
            lines.append("## Notes")
            for n in notes:
                lines.append(f"- {n['content']}")
            lines.append("")

        return "\n".join(lines).strip() + "\n"

    # ------------------------------------------------------------------
    # Heuristic extraction from user text
    # ------------------------------------------------------------------
    def auto_extract_from_user_text(self, text: str) -> None:
        if not text or not str(text).strip():
            return

        raw = str(text).strip()
        lower = raw.lower()

        # Name
        m = self._name_re.search(raw) or self._name_re2.search(raw)
        if m:
            candidate = m.group(1).strip()
            if candidate:
                cand_norm = candidate[:1].upper() + candidate[1:]
                self.add_entry(
                    type="fact",
                    content=f"Imię użytkownika: {cand_norm}" if self.language == "pl" else f"User's name: {cand_norm}",
                    tags=["name"],
                    entities=["user"],
                    confidence=0.9,
                    stability="high",
                    data={"name": cand_norm},
                )

        # Single-token name
        if self._single_token_name_re.fullmatch(raw):
            self.add_entry(
                type="fact",
                content=f"Imię użytkownika: {raw}" if self.language == "pl" else f"User's name: {raw}",
                tags=["name"],
                entities=["user"],
                confidence=0.65,
                stability="medium",
                data={"name": raw},
            )

        # Date of birth
        dob = None
        mi = self._date_iso_re.search(raw)
        if mi:
            dob = f"{mi.group(1)}-{mi.group(2)}-{mi.group(3)}"
        else:
            mp = self._date_re.search(raw)
            if mp:
                d1, d2, yyyy = int(mp.group(1)), int(mp.group(2)), int(mp.group(3))
                if 1 <= d1 <= 31 and 1 <= d2 <= 12:
                    if self.language == "en" and d2 > 12:
                        mm, dd = d2, d1
                    else:
                        dd, mm = d1, d2
                    dob = f"{yyyy:04d}-{mm:02d}-{dd:02d}"

        if dob and any(kw in lower for kw in self._dob_keywords):
            self.add_entry(
                type="event",
                content=f"Data urodzenia użytkownika: {dob}" if self.language == "pl" else f"User's date of birth: {dob}",
                tags=["birthday", "date_of_birth"],
                entities=["user"],
                confidence=0.9,
                stability="high",
                data={"date_of_birth": dob},
            )

        # Preferences / routine / context
        if self._pref_re.search(raw):
            self.add_entry(
                type="preference",
                content=f"Preferencja: {raw}" if self.language == "pl" else f"Preference: {raw}",
                tags=["preference"],
                entities=["user"],
                confidence=0.6,
                stability="low",
            )

        if self._routine_re.search(raw):
            self.add_entry(
                type="memory_note",
                content=f"Rutyna: {raw}" if self.language == "pl" else f"Routine: {raw}",
                tags=["routine"],
                entities=["user"],
                confidence=0.5,
                stability="low",
            )

        if any(kw in lower for kw in self._context_keywords):
            self.add_entry(
                type="memory_note",
                content=f"Kontekst: {raw}" if self.language == "pl" else f"Context: {raw}",
                tags=["context"],
                entities=["user"],
                confidence=0.4,
                stability="low",
            )

    # ------------------------------------------------------------------
    # Birthday helper
    # ------------------------------------------------------------------
    def get_birthday(self) -> Optional[Tuple[int, int]]:
        items = self.list_recent(limit=20, types=["event", "fact"])
        for it in items:
            data = it.get("data") or {}
            dob = data.get("date_of_birth") or data.get("birthday")
            if isinstance(dob, str):
                parts = dob.replace("/", "-").split("-")
                if len(parts) == 3:
                    try:
                        return int(parts[1]), int(parts[2])
                    except Exception:
                        continue
                if len(parts) == 2:
                    try:
                        return int(parts[0]), int(parts[1])
                    except Exception:
                        continue
        return None
