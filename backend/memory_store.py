import json
import re
import hashlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


class MemoryStore:
    """
    Cross-project user memory store.

    - WORK memory: draft profile stored as JSON + a rendered Markdown view.
    - LONG-TERM memory: canonical Markdown profile overwritten on commit + JSON snapshots kept for history.
    - Conversations: raw jsonl logs for transparency/debugging.

    Key changes vs your current version:
    - DEDUPE notes (prevents the same information being added repeatedly).
    - LONG-TERM profile.md is CANONICAL (overwritten), not appended.
    - commit_work_to_long_term() uses a hash to SKIP commits if nothing changed.
    - Optional snapshots are saved to long_term_memory/snapshots/.
    """

    def __init__(self, base_dir: Path, emit_event: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.base_dir = Path(base_dir).resolve()
        self.emit_event = emit_event

        # Heuristic extractors (PL)
        self._name_re = re.compile(
            r"(?:nazywam\s+się|mam\s+na\s+imię|moje\s+imię\s+to|imię\s+to|jestem\s+tu\s+jako|to\s+ja)\s+"
            r"([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{1,30})",
            re.IGNORECASE,
        )
        self._name_re2 = re.compile(
            r"\bjestem\s+([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż\-]{1,30})"
            r"(?!\s*(?:ok|okej|dobrze|gotowy|spoko|szczęśliwy|szczesliwy|zmęczony|zmeczony|głodny|glodny|"
            r"zajęty|zajety|chory))",
            re.IGNORECASE,
        )
        self._date_iso_re = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
        self._date_pl_re = re.compile(r"\b(\d{1,2})[\./-](\d{1,2})[\./-](\d{4})\b")
        self._pref_re = re.compile(
            r"\b(?:wolę|wole|preferuję|preferuje|lubię|lubie|nie lubię|nie lubie|nie chcę|nie chce)\b",
            re.IGNORECASE,
        )
        self._routine_re = re.compile(
            r"\b(?:codziennie|zwykle|najczęściej|najczesciej|rano|wieczorem|w weekendy)\b",
            re.IGNORECASE,
        )

    # ----------------------------------------------------------------------------------
    # Paths / bootstrap
    # ----------------------------------------------------------------------------------
    def _iso_now(self) -> str:
        return datetime.now().astimezone().isoformat(timespec="seconds")

    def _paths(self):
        mem_dir = self.base_dir / "user_memory"
        mem_dir.mkdir(parents=True, exist_ok=True)

        work_json = mem_dir / "work_profile.json"
        work_md = mem_dir / "work_profile.md"

        lt_dir = self.base_dir / "long_term_memory"
        lt_dir.mkdir(parents=True, exist_ok=True)
        lt_profile = lt_dir / "profile.md"
        lt_meta = lt_dir / "profile_meta.json"

        snapshots_dir = lt_dir / "snapshots"
        snapshots_dir.mkdir(parents=True, exist_ok=True)

        convo_dir = mem_dir / "conversations"
        convo_dir.mkdir(parents=True, exist_ok=True)

        audit_file = mem_dir / "memory_audit.jsonl"

        return work_json, work_md, lt_profile, lt_meta, snapshots_dir, convo_dir, audit_file

    def bootstrap(self) -> None:
        work_json, work_md, lt_profile, _, _, convo_dir, audit_file = self._paths()

        if not work_json.exists():
            work_json.write_text("{}\n", encoding="utf-8")
        if not work_md.exists():
            work_md.write_text(self._render_work_profile_md({}), encoding="utf-8")

        if not lt_profile.exists():
            lt_profile.write_text("# Long-Term User Memory\n\n(empty)\n", encoding="utf-8")

        if not audit_file.exists():
            audit_file.write_text("", encoding="utf-8")

        try:
            convo_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

    # ----------------------------------------------------------------------------------
    # Work profile read/write
    # ----------------------------------------------------------------------------------
    def _load_work(self) -> Dict[str, Any]:
        work_json, _, _, _, _, _, _ = self._paths()
        try:
            if not work_json.exists():
                return {}
            data = json.loads(work_json.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_work(self, profile: Dict[str, Any]) -> None:
        work_json, work_md, _, _, _, _, _ = self._paths()
        work_json.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        work_md.write_text(self._render_work_profile_md(profile), encoding="utf-8")

    def _render_work_profile_md(self, profile: Dict[str, Any]) -> str:
        lines: List[str] = []
        lines.append("# Work User Memory (draft)")
        lines.append(f"_Updated: {self._iso_now()}_")
        lines.append("")

        notes = profile.get("_notes", [])
        core = {k: v for k, v in profile.items() if k != "_notes"}

        if core:
            lines.append("## Profile")
            for k, v in core.items():
                if isinstance(v, (dict, list)):
                    vv = json.dumps(v, ensure_ascii=False, indent=2)
                    lines.append(f"- **{k}**:\n```json\n{vv}\n```")
                else:
                    lines.append(f"- **{k}**: {v}")
            lines.append("")

        if notes:
            lines.append("## Notes")
            for n in notes[-50:]:
                lines.append(f"- {n}")
            lines.append("")

        return "\n".join(lines).strip() + "\n"

    # ----------------------------------------------------------------------------------
    # Conversation + audit
    # ----------------------------------------------------------------------------------
    def append_conversation(self, sender: str, text: str) -> None:
        if not text or not str(text).strip():
            return
        _, _, _, _, _, convo_dir, _ = self._paths()
        day = datetime.now().strftime("%Y%m%d")
        logfile = convo_dir / f"{day}.jsonl"
        entry = {"ts": self._iso_now(), "sender": sender, "text": str(text)}
        try:
            logfile.parent.mkdir(parents=True, exist_ok=True)
            with open(logfile, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _audit(self, payload: Dict[str, Any]) -> None:
        _, _, _, _, _, _, audit_file = self._paths()
        try:
            with open(audit_file, "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": self._iso_now(), **payload}, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def _emit(self, payload: Dict[str, Any]) -> None:
        if not self.emit_event:
            return
        try:
            self.emit_event(payload)
        except Exception:
            pass

    # ----------------------------------------------------------------------------------
    # Dedupe helpers
    # ----------------------------------------------------------------------------------
    _ws_re = re.compile(r"\s+", re.UNICODE)

    def _note_body(self, note_line: str) -> str:
        """
        Stored note lines look like: "2026-01-04T21:12:00+01:00 — something".
        We dedupe by comparing "something".
        """
        s = (note_line or "").strip()
        if " — " in s:
            s = s.split(" — ", 1)[1]
        return s.strip()

    def _note_key(self, note_body: str) -> str:
        """
        Normalize for dedupe:
        - lowercase
        - collapse whitespace
        - strip outer punctuation
        """
        s = (note_body or "").strip().lower()
        s = self._ws_re.sub(" ", s)
        s = s.strip(" \t\r\n.,;:!?'\"()[]{}")
        return s

    def _safe_label(self, label: str) -> str:
        s = (label or "snapshot").strip()
        s = re.sub(r"[^a-zA-Z0-9_-]+", "_", s)
        return s[:48] if s else "snapshot"

    def _canonical_hash(self, profile: Dict[str, Any]) -> str:
        canonical_json = json.dumps(profile, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()

    # ----------------------------------------------------------------------------------
    # Public API used by monikai.py
    # ----------------------------------------------------------------------------------
    def apply_work_update(
        self,
        set_obj: Optional[Dict[str, Any]] = None,
        append_notes: Optional[List[str]] = None,
        source: str = "tool",
    ) -> str:
        """
        Applies updates to work memory.
        - Set fields from set_obj
        - Append notes (with dedupe)
        """
        profile = self._load_work()
        set_obj = set_obj or {}
        append_notes = append_notes or []

        changed: List[str] = []

        # Only mark "changed" if the value differs
        if isinstance(set_obj, dict):
            for k, v in set_obj.items():
                if profile.get(k) != v:
                    profile[k] = v
                    changed.append(k)

        # Notes dedupe
        notes_added = 0
        if append_notes:
            profile.setdefault("_notes", [])
            existing_keys = {self._note_key(self._note_body(n)) for n in profile.get("_notes", []) if isinstance(n, str)}

            for n in append_notes:
                if not (isinstance(n, str) and n.strip()):
                    continue
                body = n.strip()
                key = self._note_key(body)
                if not key:
                    continue
                if key in existing_keys:
                    continue
                profile["_notes"].append(f"{self._iso_now()} — {body}")
                existing_keys.add(key)
                notes_added += 1

        # Save only if something changed or notes were added
        if changed or notes_added:
            self._save_work(profile)

        summary = "updated: " + (", ".join(changed) if changed else ("notes" if notes_added else "no-op"))
        if changed or notes_added:
            self._emit({"kind": "work_update", "summary": f"{summary} ({source})"})
            self._audit(
                {
                    "kind": "work_update",
                    "source": source,
                    "changed_keys": changed,
                    "notes_added": notes_added,
                }
            )
        return summary

    def get_work_markdown(self) -> str:
        _, work_md, _, _, _, _, _ = self._paths()
        try:
            return work_md.read_text(encoding="utf-8")
        except Exception:
            return "# Work User Memory (draft)\n\n(error reading file)\n"

    
# ------------------------------------------------------------------
# Public API expected by monikai.py (compat wrappers)
# ------------------------------------------------------------------
def observe_user_text(self, text: str) -> dict:
    """Alias for auto_update_from_user_text used by monikai.py."""
    return self.auto_update_from_user_text(text)

def commit_work_to_long_term(self, label: Optional[str] = None) -> str:
        """
        Writes:
        - long_term_memory/profile.md  (CANONICAL: overwritten)
        - long_term_memory/snapshots/<ts>__<label>.json (history)
        - long_term_memory/profile_meta.json (hash + last commit)
        """
        work = self._load_work()
        _, _, lt_profile, lt_meta, snapshots_dir, _, _ = self._paths()

        safe_label = self._safe_label(label or "snapshot")
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")

        new_hash = self._canonical_hash(work)

        old_hash = None
        if lt_meta.exists():
            try:
                meta = json.loads(lt_meta.read_text(encoding="utf-8"))
                if isinstance(meta, dict):
                    old_hash = meta.get("hash")
            except Exception:
                old_hash = None

        # Skip commit if no changes since last commit
        if old_hash == new_hash:
            self._emit({"kind": "commit_skip", "summary": f"Skipped commit (no changes) ({safe_label})"})
            self._audit({"kind": "commit_skip", "label": safe_label})
            return f"skipped (no changes) ({safe_label})"

        # Snapshot JSON (history)
        snap_path = snapshots_dir / f"{ts}__{safe_label}.json"
        try:
            snap_path.write_text(json.dumps(work, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as e:
            raise RuntimeError(f"Failed to write snapshot: {e}") from e

        # Canonical long-term markdown
        md = self._render_work_profile_md(work)
        # Make the heading match long-term semantics
        if md.startswith("# Work User Memory (draft)"):
            md = md.replace("# Work User Memory (draft)", "# Long-Term User Memory", 1)

        try:
            lt_profile.write_text(md, encoding="utf-8")
        except Exception as e:
            raise RuntimeError(f"Failed to write long-term profile: {e}") from e

        # Meta
        try:
            lt_meta.write_text(
                json.dumps(
                    {
                        "hash": new_hash,
                        "last_commit_ts": ts,
                        "label": safe_label,
                        "snapshot_file": snap_path.name,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
        except Exception:
            # Meta write failure should not break functionality
            pass

        self._emit({"kind": "commit", "summary": f"Committed WORK -> LONG-TERM ({safe_label})"})
        self._audit({"kind": "commit", "label": safe_label, "snapshot": snap_path.name})
        return f"ok ({safe_label})"

    
def clear_work(self) -> str:
    """Clear WORK memory (does not delete LONG-TERM snapshots)."""
    self._save_work({})
    # Also refresh the markdown view so frontend doesn't show stale text
    try:
        self._save_work_markdown(self._render_work_markdown({}))
    except Exception:
        pass

    self._emit({"type": "work_cleared"})
    return "WORK memory cleared."


    def auto_update_from_user_text(self, user_text: str) -> None:
        """
        Conservative extractor. It WILL still add notes often, but:
        - notes are deduped
        - set fields only change if different
        """
        if not user_text or not str(user_text).strip():
            return

        text = str(user_text).strip()
        lower = text.lower()

        set_obj: Dict[str, Any] = {}
        notes: List[str] = []

        # Load once (avoid repeated disk read)
        existing_profile = self._load_work()
        existing_name = (existing_profile.get("name") or "").strip()

        # Name
        m = self._name_re.search(text) or self._name_re2.search(text)
        if m:
            candidate = m.group(1).strip()
            if candidate:
                # Normalize casing slightly (first letter uppercase) without overcorrecting
                cand_norm = candidate[:1].upper() + candidate[1:]
                if not existing_name or existing_name != cand_norm:
                    set_obj["name"] = cand_norm

        # Single-token name
        if "name" not in set_obj:
            if not existing_name and re.fullmatch(r"[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{1,30}", text):
                set_obj["name"] = text
                notes.append("Captured single-token name from user turn.")

        # Date of birth (only if explicitly mentioned)
        dob = None
        mi = self._date_iso_re.search(text)
        if mi:
            dob = f"{mi.group(1)}-{mi.group(2)}-{mi.group(3)}"
        else:
            mp = self._date_pl_re.search(text)
            if mp:
                dd, mm, yyyy = int(mp.group(1)), int(mp.group(2)), int(mp.group(3))
                if 1 <= dd <= 31 and 1 <= mm <= 12:
                    dob = f"{yyyy:04d}-{mm:02d}-{dd:02d}"
        if dob and ("urodzi" in lower or "urodzin" in lower or "data urod" in lower):
            if existing_profile.get("date_of_birth") != dob:
                set_obj["date_of_birth"] = dob

        # Preferences/routine as notes (dedupe will prevent repeats)
        if self._pref_re.search(text):
            notes.append(f"Preference mentioned: {text}")
        if self._routine_re.search(text):
            notes.append(f"Routine mentioned: {text}")

        # General context note (only if it looks like stable-ish info)
        if not set_obj and not notes:
            if any(tok in lower for tok in ["mam", "mój", "moja", "moje", "pracuję", "pracuje", "robię", "robie", "chciałbym", "chcialbym"]):
                notes.append(f"Life/context: {text}")

        if set_obj or notes:
            self.apply_work_update(set_obj=set_obj, append_notes=notes, source="auto")
