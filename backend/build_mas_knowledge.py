from pathlib import Path
from mas_knowledge import build_mas_knowledge
import json


def main():
    base = Path(__file__).resolve().parent
    scripts_dir = base.parent / "scripts"
    out_path = base / "mas_knowledge.json"

    data = build_mas_knowledge(scripts_dir)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved MAS knowledge to {out_path}")


if __name__ == "__main__":
    main()

