"""OCR for Go backend — outputs JSON with word-level bounding boxes.
Usage: python ocr.py <image_path>
Output: [{"text":"...", "x":int, "y":int, "w":int, "h":int}, ...]
"""
import sys
import json
from pathlib import Path

try:
    import easyocr
except ImportError:
    print("[]")
    sys.exit(0)


def bbox_to_rect(bbox):
    """Convert EasyOCR 4-point bbox to {x, y, w, h}."""
    x_coords = [p[0] for p in bbox]
    y_coords = [p[1] for p in bbox]
    x = int(min(x_coords))
    y = int(min(y_coords))
    w = int(max(x_coords) - x)
    h = int(max(y_coords) - y)
    return x, y, w, h


def main():
    if len(sys.argv) < 2:
        print("[]")
        sys.exit(1)

    image_path = Path(sys.argv[1])
    if not image_path.exists():
        print("[]")
        sys.exit(1)

    reader = easyocr.Reader(["ch_sim", "en"], gpu=False)
    results = reader.readtext(str(image_path))

    items = []
    for bbox, text, confidence in results:
        text = text.strip()
        if not text:
            continue
        x, y, w, h = bbox_to_rect(bbox)
        items.append({"text": text, "x": x, "y": y, "w": w, "h": h})

    # Fix: ensure stdout can handle CJK chars on Windows
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    print(json.dumps(items, ensure_ascii=False))


if __name__ == "__main__":
    main()
