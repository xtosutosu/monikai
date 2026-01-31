import json
import os
import re
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


WORD_RE = re.compile(r"[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9']{2,}")


def _tokenize(text: str) -> List[str]:
    return WORD_RE.findall((text or "").lower())


def _clean_dialogue(text: str) -> str:
    if not text:
        return ""
    # Remove Ren'Py inline tags like {w=0.2}, {i} etc.
    text = re.sub(r"\{[^}]+\}", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _parse_dialogue_lines(text: str) -> List[str]:
    dlg_re = re.compile(r'^\s*m\b[^"\n]*"([^"]+)"', re.MULTILINE)
    out: List[str] = []
    for m in dlg_re.finditer(text):
        line = _clean_dialogue(m.group(1))
        if line:
            out.append(line)
    return out


def _parse_events(text: str) -> List[Dict[str, Any]]:
    block_re = re.compile(r"addEvent\\(Event\\((.*?)\\)\\)", re.DOTALL)
    events: List[Dict[str, Any]] = []
    for block in block_re.findall(text):
        pm = re.search(r'prompt="([^"]+)"', block)
        if not pm:
            continue
        prompt = pm.group(1).strip()
        eventlabel = None
        em = re.search(r'eventlabel="([^"]+)"', block)
        if em:
            eventlabel = em.group(1).strip()

        cats: List[str] = []
        cm = re.search(r"category=\\[([^\\]]+)\\]", block)
        if cm:
            for a, b in re.findall(r"'([^']+)'|\"([^\"]+)\"", cm.group(1)):
                c = a or b
                if c:
                    cats.append(c)

        events.append({"prompt": prompt, "eventlabel": eventlabel, "categories": cats})
    return events


def _extract_facts(lines: List[str]) -> List[str]:
    patterns = [
        r"\bI am\b",
        r"\bI'm\b",
        r"\bI was\b",
        r"\bI like\b",
        r"\bI love\b",
        r"\bI prefer\b",
        r"\bI enjoy\b",
        r"\bMy favorite\b",
        r"\bMy favourite\b",
        r"\bI don't like\b",
        r"\bI hate\b",
        r"\bI used to\b",
    ]
    pat = re.compile("|".join(patterns))
    out: List[str] = []
    seen = set()
    for line in lines:
        if len(line) < 16 or len(line) > 160:
            continue
        if not pat.search(line):
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
    return out


def _style_stats(lines: List[str]) -> Dict[str, Any]:
    interjections = ["ahaha", "ehehe", "haha", "hahaha", "hehe", "hmm", "um", "uh", "well"]
    counts = {k: 0 for k in interjections}
    for line in lines:
        low = line.lower()
        for it in interjections:
            if it in low:
                counts[it] += 1
    return {"interjections": counts, "lines": len(lines)}


def build_mas_knowledge(scripts_dir: Path) -> Dict[str, Any]:
    scripts_dir = Path(scripts_dir)
    rpy_files = sorted([p for p in scripts_dir.glob("*.rpy") if p.is_file()])
    if not rpy_files:
        return {
            "topics": [],
            "facts": [],
            "style": {},
            "samples": {},
        }

    all_lines: List[str] = []
    all_events: List[Dict[str, Any]] = []
    samples: Dict[str, List[str]] = {
        "greetings": [],
        "farewells": [],
        "brbs": [],
        "apologies": [],
        "compliments": [],
    }

    sample_files = {
        "greetings": "script-greetings.rpy",
        "farewells": "script-farewells.rpy",
        "brbs": "script-brbs.rpy",
        "apologies": "script-apologies.rpy",
        "compliments": "script-compliments.rpy",
    }

    for path in rpy_files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = _parse_dialogue_lines(text)
        all_lines.extend(lines)
        all_events.extend(_parse_events(text))

        for key, fname in sample_files.items():
            if path.name == fname:
                samples[key].extend(lines)

    # Deduplicate samples, limit size
    for key in samples:
        seen = set()
        uniq = []
        for line in samples[key]:
            if line not in seen:
                uniq.append(line)
                seen.add(line)
            if len(uniq) >= 200:
                break
        samples[key] = uniq

    facts = _extract_facts(all_lines)
    style = _style_stats(all_lines)

    # Normalize events: unique by prompt+eventlabel
    seen_events = set()
    topics: List[Dict[str, Any]] = []
    for ev in all_events:
        key = f"{ev.get('eventlabel')}|{ev.get('prompt')}"
        if key in seen_events:
            continue
        seen_events.add(key)
        topics.append(ev)

    return {
        "topics": topics,
        "facts": facts,
        "style": style,
        "samples": samples,
    }


def _latest_mtime(paths: List[Path]) -> float:
    latest = 0.0
    for p in paths:
        try:
            latest = max(latest, p.stat().st_mtime)
        except Exception:
            pass
    return latest


def ensure_knowledge(
    scripts_dir: Path,
    out_path: Path,
    *,
    force: bool = False,
) -> Optional[Path]:
    scripts_dir = Path(scripts_dir)
    out_path = Path(out_path)
    rpy_files = list(scripts_dir.glob("*.rpy"))
    if not rpy_files:
        return None

    if force or (not out_path.exists()):
        data = build_mas_knowledge(scripts_dir)
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return out_path

    latest_scripts = _latest_mtime(rpy_files)
    try:
        if out_path.stat().st_mtime < latest_scripts:
            data = build_mas_knowledge(scripts_dir)
            out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            return out_path
    except Exception:
        pass

    return out_path


class MasKnowledge:
    def __init__(self, data: Dict[str, Any]):
        self.data = data or {}
        self.topics: List[Dict[str, Any]] = list(self.data.get("topics") or [])
        self.facts: List[str] = list(self.data.get("facts") or [])
        self.samples: Dict[str, List[str]] = dict(self.data.get("samples") or {})
        self.style: Dict[str, Any] = dict(self.data.get("style") or {})

        self._items: List[Dict[str, Any]] = []
        self._category_index: Dict[str, List[Dict[str, Any]]] = {}
        for t in self.topics:
            self._items.append({"type": "topic", "text": t.get("prompt", ""), "meta": t})
            for cat in t.get("categories") or []:
                self._category_index.setdefault(cat, []).append(t)
        for f in self.facts:
            self._items.append({"type": "fact", "text": f})

        self._item_tokens: List[set] = [set(_tokenize(it.get("text", ""))) for it in self._items]

    def _score(self, q_tokens: set, idx: int, query: str) -> int:
        tokens = self._item_tokens[idx]
        overlap = len(q_tokens & tokens)
        if overlap <= 0:
            return 0
        text = (self._items[idx].get("text") or "").lower()
        if query and query.lower() in text:
            overlap += 3
        return overlap

    def _category_match(self, query: str) -> Optional[str]:
        if not query:
            return None
        q = query.lower()
        mapping = {
            "literature": ["książ", "ksiaz", "poez", "wiersz", "pisan", "literatur", "czyt"],
            "music": ["muzyk", "piosenk", "instrument", "pianin", "gitara", "śpiew", "spiew", "koncert"],
            "games": ["gra", "gry", "game", "visual novel", "vn"],
            "ddlc": ["ddlc", "klub literacki", "sayori", "yuri", "natsuki", "dokis"],
            "philosophy": ["filozof", "świadomo", "swiadomo", "wolna wola", "symulac", "sens", "egzyst", "determinizm"],
            "psychology": ["psycholog", "samopocz", "emocj", "lęk", "lek", "stres", "depres", "niepok"],
            "romance": ["miłość", "milosc", "związek", "zwiazek", "relacj", "randk", "uczuc", "serce"],
            "life": ["nawyk", "rutyn", "plan", "praca", "zmęcz", "zmecz", "odpocz", "sen", "zdrow", "motyw"],
            "nature": ["natura", "pogod", "zima", "wiosn", "lato", "jesień", "jesien", "śnieg", "snieg", "gwiazd"],
            "society": ["społeczn", "spoleczn", "kultura", "norm", "miasto", "społeczeń", "spoleczen"],
            "technology": ["technolog", "program", "kod", "ai", "sztuczna inteligencja", "komputer"],
            "trivia": ["ciekawost", "trivia", "fun fact"],
            "holidays": ["święt", "swiet", "boże narodzenie", "boze narodzenie", "nowy rok", "walentyn", "halloween"],
            "school": ["szkoł", "szkol", "studia", "uczelni", "egzamin"],
        }
        for cat, keys in mapping.items():
            if any(k in q for k in keys):
                return cat
        return None

    def search(self, query: str, top_k: int = 6) -> List[Dict[str, Any]]:
        q_tokens = set(_tokenize(query))
        if not q_tokens:
            return []
        scored: List[Tuple[int, Dict[str, Any]]] = []
        for i in range(len(self._items)):
            score = self._score(q_tokens, i, query)
            if score > 0:
                scored.append((score, self._items[i]))
        scored.sort(key=lambda x: x[0], reverse=True)
        if scored:
            return [item for _, item in scored[:top_k]]

        # Fallback: map Polish keywords to MAS categories
        cat = self._category_match(query)
        if cat and cat in self._category_index:
            picks = self._category_index[cat][:top_k]
            return [{"type": "topic", "text": t.get("prompt", ""), "meta": t} for t in picks if t.get("prompt")]
        return []

    def pick_topics(self, seed: str = "", k: int = 2) -> List[str]:
        if not self.topics:
            return []
        # Category-based pick for Polish queries
        cat = self._category_match(seed)
        if cat and cat in self._category_index:
            items = [t.get("prompt", "") for t in self._category_index[cat] if t.get("prompt")]
            if items:
                return random.sample(items, k=min(k, len(items)))
        seed_tokens = set(_tokenize(seed))
        if seed_tokens:
            scored = []
            for t in self.topics:
                tokens = set(_tokenize(t.get("prompt", "")))
                overlap = len(seed_tokens & tokens)
                if overlap > 0:
                    scored.append((overlap, t.get("prompt", "")))
            scored.sort(key=lambda x: x[0], reverse=True)
            picks = [p for _, p in scored[:k] if p]
            if picks:
                return picks
        # fallback random
        return random.sample([t.get("prompt", "") for t in self.topics if t.get("prompt")], k=min(k, len(self.topics)))

    def build_context(self, query: str, max_topics: int = 3, max_facts: int = 2) -> str:
        items = self.search(query, top_k=8)
        topics: List[str] = []
        facts: List[str] = []
        for item in items:
            if item["type"] == "topic":
                prompt = item.get("meta", {}).get("prompt", "")
                if prompt and prompt not in topics:
                    topics.append(prompt)
            elif item["type"] == "fact":
                text = item.get("text", "")
                if text and text not in facts:
                    facts.append(text)
            if len(topics) >= max_topics and len(facts) >= max_facts:
                break

        lines: List[str] = []
        if topics:
            lines.append("Powiązane tematy MAS: " + "; ".join(topics[:max_topics]) + ".")
        if facts:
            # Keep short and avoid overly long lines
            trimmed = []
            for f in facts[:max_facts]:
                if len(f) > 140:
                    trimmed.append(f[:137] + "...")
                else:
                    trimmed.append(f)
            lines.append("Wątki wiedzy MAS (skrót): " + " / ".join(trimmed) + ".")

        return "\n".join(f"- {line}" for line in lines).strip()


def load_mas_knowledge(path: Path) -> Optional[MasKnowledge]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return MasKnowledge(data)
    except Exception:
        return None
    return None
