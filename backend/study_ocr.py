import base64
import io
import json
import os
import threading
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image

_PADDLE_OCR_INSTANCES = {}
_PADDLE_OCR_LOCK = threading.Lock()


def _resolve_paddle_home() -> Optional[str]:
    env = os.getenv("PADDLEOCR_HOME")
    if env and os.path.isdir(env):
        return env
    try:
        base = Path(__file__).resolve().parent.parent
        candidate = base / "data" / "paddleocr"
        candidate.mkdir(parents=True, exist_ok=True)
        return str(candidate)
    except Exception:
        return None


def _resolve_ocr_lang(lang: Optional[str]) -> str:
    if lang:
        return str(lang).strip().lower()
    env = os.getenv("STUDY_OCR_LANG")
    if env:
        return env.strip().lower()
    return "japan"


def _resolve_ocr_use_gpu(use_gpu: Optional[bool]) -> bool:
    if use_gpu is not None:
        return bool(use_gpu)
    env = os.getenv("STUDY_OCR_USE_GPU", "").strip().lower()
    if env in ("1", "true", "yes", "y", "on"):
        return True
    if env in ("0", "false", "no", "n", "off"):
        return False
    return False


def _get_paddle_ocr(lang: Optional[str] = None, use_gpu: Optional[bool] = None):
    lang = _resolve_ocr_lang(lang)
    use_gpu = _resolve_ocr_use_gpu(use_gpu)
    key = f"{lang}|{int(use_gpu)}"
    if key in _PADDLE_OCR_INSTANCES:
        return _PADDLE_OCR_INSTANCES[key]
    with _PADDLE_OCR_LOCK:
        if key in _PADDLE_OCR_INSTANCES:
            return _PADDLE_OCR_INSTANCES[key]
        try:
            paddle_home = _resolve_paddle_home()
            if paddle_home:
                os.environ["PADDLEOCR_HOME"] = paddle_home
            from paddleocr import PaddleOCR  # optional dependency
            instance = PaddleOCR(
                use_angle_cls=False,
                lang=lang,
                use_gpu=use_gpu,
                show_log=False,
            )
            _PADDLE_OCR_INSTANCES[key] = instance
            return instance
        except Exception as e:
            try:
                print(f"[Study OCR] PaddleOCR init failed: {e}")
            except Exception:
                pass
            return None


def _paddle_ocr_image_bytes(
    image_bytes: bytes,
    lang: Optional[str] = None,
    use_gpu: Optional[bool] = None,
) -> Tuple[Optional[str], Optional[str]]:
    ocr = _get_paddle_ocr(lang=lang, use_gpu=use_gpu)
    if not ocr:
        return None, "paddleocr_missing"
    try:
        try:
            import numpy as np
        except Exception:
            return None, "numpy_missing"
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        arr = np.array(img)
        result = ocr.ocr(arr, cls=False)
        if not result:
            return None, "paddleocr_no_text"
        lines = []
        for page in result:
            for line in page:
                if not line or len(line) < 2:
                    continue
                text = line[1][0]
                if text:
                    lines.append(text)
        if not lines:
            return None, "paddleocr_no_text"
        return "\n".join(lines), None
    except Exception as e:
        return None, str(e)


def _paddle_ocr_remote(image_bytes: bytes) -> Tuple[Optional[str], Optional[str]]:
    endpoint = os.getenv("STUDY_OCR_ENDPOINT", "").strip()
    if not endpoint:
        return None, "paddleocr_remote_disabled"
    try:
        payload = {
            "image_b64": base64.b64encode(image_bytes).decode("ascii")
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read()
        parsed = json.loads(raw.decode("utf-8", errors="ignore") or "{}")
        text = parsed.get("text")
        if not text:
            return None, parsed.get("error") or "paddleocr_no_text"
        return text, None
    except Exception as e:
        return None, f"paddleocr_remote_failed: {e}"


def ocr_image_bytes(
    image_bytes: bytes,
    lang: Optional[str] = None,
    use_gpu: Optional[bool] = None,
    engine: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str]]:
    """
    Returns (text, error). If OCR is unavailable, returns (None, reason).
    """
    mode = (engine or os.getenv("STUDY_OCR_ENGINE") or "local").strip().lower()

    if mode in ("remote", "auto"):
        text, err = _paddle_ocr_remote(image_bytes)
        if text:
            return text, None
        if mode == "remote":
            return None, err or "paddleocr_remote_failed"

    # Local PaddleOCR (default)
    text, err = _paddle_ocr_image_bytes(image_bytes, lang=lang, use_gpu=use_gpu)
    if text:
        return text, None

    # If local fails and endpoint exists, try remote as fallback
    if mode in ("local", "auto"):
        text, err2 = _paddle_ocr_remote(image_bytes)
        if text:
            return text, None
        if err2 and err2 != "paddleocr_remote_disabled":
            return None, err2

    return None, err or "paddleocr_failed"
