"""Edge TTS microservice — persistent process, multi-threaded, no cold-start."""
import sys, io, json, asyncio, threading, base64, os
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

try:
    import edge_tts
except ImportError:
    print("[tts_server] pip install edge-tts", file=sys.stderr)
    sys.exit(1)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 19527
RATE = "+20%"
MAX_CONCURRENT = int(os.environ.get("TTS_CONCURRENT", "3"))

_tts_sem = threading.Semaphore(MAX_CONCURRENT)

class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        text = body.get("text", "").strip()
        voice = body.get("voice", "zh-CN-XiaoxiaoNeural")

        if not text:
            self.send_error(400, "empty text")
            return

        acquired = _tts_sem.acquire(timeout=15)
        if not acquired:
            self.send_error(503, "tts server busy")
            return

        try:
            mp3 = _run_async(_synthesize(text, voice))
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(mp3)))
            self.end_headers()
            self.wfile.write(mp3)
        except Exception as e:
            self.send_error(500, str(e))
        finally:
            _tts_sem.release()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass

async def _synthesize(text, voice):
    communicate = edge_tts.Communicate(text, voice, rate=RATE)
    mp3 = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            mp3.write(chunk["data"])
    return mp3.getvalue()

def _run_async(coro):
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    new_loop = asyncio.new_event_loop()
    try:
        return new_loop.run_until_complete(coro)
    finally:
        new_loop.close()

def _warmup():
    try:
        print(f"[tts_server] warming up Edge TTS connection...")
        _run_async(_synthesize("hello", "zh-CN-XiaoxiaoNeural"))
        print("[tts_server] warmup complete")
    except Exception as e:
        print(f"[tts_server] warmup failed (non-fatal): {e}")

if __name__ == "__main__":
    _warmup()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), TTSHandler)
    print(f"[tts_server] listening on 127.0.0.1:{PORT} (threads, max_concurrent={MAX_CONCURRENT})")
    server.serve_forever()
