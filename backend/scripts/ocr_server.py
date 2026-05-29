"""Persistent EasyOCR HTTP server — keeps model loaded between requests.
Usage: python ocr_server.py [port]
Default port: 29529
"""
import sys
import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import cv2
import numpy as np

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 29529
reader = None
use_gpu = False


def bbox_to_rect(bbox):
    x_coords = [p[0] for p in bbox]
    y_coords = [p[1] for p in bbox]
    x = int(min(x_coords))
    y = int(min(y_coords))
    w = int(max(x_coords) - x)
    h = int(max(y_coords) - y)
    return x, y, w, h


def preprocess(image_path):
    """Enhance image for better OCR accuracy.
    Returns (preprocessed_path_or_None, scale_factor).
    """
    img = cv2.imread(image_path)
    if img is None:
        return None, 1.0

    h, w = img.shape[:2]
    if h < 8 or w < 8:
        return None, 1.0
    scale = 1.0

    # Upscale small images so text features are clearer
    min_dim = min(w, h)
    if min_dim < 400:
        scale = 800.0 / max(min_dim, 1)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    elif min_dim < 800:
        scale = 1200.0 / max(min_dim, 1)
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # CLAHE on L channel of LAB for contrast (only for 3-channel color images)
    if len(img.shape) == 3 and img.shape[2] == 3:
        lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge([l, a, b])
        img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # Mild sharpening
    kernel = np.array([[-0.5, -1, -0.5],
                       [-1, 7.5, -1],
                       [-0.5, -1, -0.5]], dtype=np.float32)
    img = cv2.filter2D(img, -1, kernel)

    out_path = image_path + ".enhanced.png"
    cv2.imwrite(out_path, img)
    return out_path, scale


def unscale_items(items, scale):
    """Scale bounding box coordinates back to original image dimensions."""
    if scale == 1.0:
        return items
    for item in items:
        item["x"] = int(item["x"] / scale)
        item["y"] = int(item["y"] / scale)
        item["w"] = int(item["w"] / scale)
        item["h"] = int(item["h"] / scale)
    return items


class OCRHandler(BaseHTTPRequestHandler):
    def _json_error(self, code, msg):
        resp = json.dumps({"error": msg}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def _json_ok(self, data):
        resp = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)

    def do_POST(self):
        if self.path != "/ocr":
            self._json_error(404, "not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8")
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            self._json_error(400, "invalid JSON body")
            return

        image_path = req.get("image", "")
        if not image_path or not Path(image_path).exists():
            self._json_error(400, "image path not found: " + image_path)
            return

        # Optional: skip preprocessing with ?preprocess=0
        do_preprocess = req.get("preprocess", True)
        enhanced_path = None
        scale = 1.0

        try:
            if do_preprocess:
                enhanced_path, scale = preprocess(image_path)
                ocr_input = enhanced_path or image_path
            else:
                ocr_input = image_path
        except Exception as e:
            # OpenCV preprocessing can segfault on malformed images;
            # fall back to the raw image instead of crashing
            print(json.dumps({"event": "ocr", "warning": "preprocess failed, using raw image: " + str(e)}))
            ocr_input = image_path
            scale = 1.0

        try:
            results = reader.readtext(
                ocr_input,
                paragraph=req.get("paragraph", True),
                text_threshold=req.get("text_threshold", 0.55),
                width_ths=req.get("width_ths", 0.5),
            )
        except Exception as e:
            if enhanced_path:
                try:
                    os.remove(enhanced_path)
                except OSError:
                    pass
            self._json_error(500, "OCR failed: " + str(e))
            return

        # Clean up enhanced temp file
        if enhanced_path:
            try:
                os.remove(enhanced_path)
            except OSError:
                pass

        items = []
        for bbox, text, confidence in results:
            text = text.strip()
            if not text:
                continue
            if confidence < 0.2:
                continue
            x, y, w, h = bbox_to_rect(bbox)
            items.append({"text": text, "x": x, "y": y, "w": w, "h": h, "conf": round(confidence, 2)})

        items = unscale_items(items, scale)
        self._json_ok(items)

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        if self.path == "/ocr":
            print(json.dumps({"event": "ocr", "status": args[0], "size": args[2] if len(args) > 2 else ""}))


if __name__ == "__main__":
    import easyocr

    # Auto-detect GPU
    try:
        import torch
        use_gpu = torch.cuda.is_available()
    except Exception:
        use_gpu = False

    print(json.dumps({"event": "loading", "gpu": use_gpu, "message": "EasyOCR model loading..."}))
    sys.stdout.flush()

    reader = easyocr.Reader(["ch_sim", "en"], gpu=use_gpu)
    print(json.dumps({"event": "ready", "port": PORT, "gpu": use_gpu}))
    sys.stdout.flush()

    server = HTTPServer(("127.0.0.1", PORT), OCRHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
