import base64
import io
import os
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image
import numpy as np

from paddleocr import PaddleOCR


def _resolve_paddle_home() -> str:
    env = os.getenv("PADDLEOCR_HOME")
    if env:
        return env
    try:
        base = Path(__file__).resolve().parent.parent
        candidate = base / "data" / "paddleocr"
        candidate.mkdir(parents=True, exist_ok=True)
        return str(candidate)
    except Exception:
        return ""


PADDLE_HOME = _resolve_paddle_home()
if PADDLE_HOME:
    os.environ["PADDLEOCR_HOME"] = PADDLE_HOME

app = FastAPI()

ocr = PaddleOCR(
    use_angle_cls=False,
    lang="japan",
    use_gpu=False,
    show_log=False,
)


class OCRRequest(BaseModel):
    image_b64: str


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
def ocr_image(req: OCRRequest):
    try:
        raw = base64.b64decode(req.image_b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        arr = np.array(img)
        result = ocr.ocr(arr, cls=False)
        if not result:
            return {"text": "", "error": "paddleocr_no_text"}
        lines = []
        for page in result:
            for line in page:
                if not line or len(line) < 2:
                    continue
                text = line[1][0]
                if text:
                    lines.append(text)
        return {"text": "\n".join(lines), "error": ""}
    except Exception as e:
        return {"text": "", "error": str(e)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8808)
