"""Private, bounded JPEG classifier. No upload files, request-body logs or network inference."""
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image
import torch
from transformers import AutoModelForImageClassification, ViTImageProcessorPil

MODEL = "Falconsai/nsfw_image_detection@96cb0d0342c7afb80cab76ecc58b265fa44da256"
MAX_BYTES = 8 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 1600 * 1600
torch.set_num_threads(2)
processor = ViTImageProcessorPil.from_pretrained("/model", local_files_only=True)
model = AutoModelForImageClassification.from_pretrained("/model", local_files_only=True, use_safetensors=True).eval()
slot = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *_args):
        pass

    def answer(self, status, data):
        encoded = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.answer(200 if self.path == "/health" else 404, {"ready": True})

    def do_POST(self):
        self.connection.settimeout(5)
        if self.path != "/scan" or self.headers.get("Content-Type") != "image/jpeg":
            self.answer(400, {"error": "invalid_request"}); return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BYTES or self.headers.get("Transfer-Encoding"):
            self.answer(413, {"error": "size"}); return
        if not slot.acquire(blocking=False):
            self.answer(503, {"error": "busy"}); return
        try:
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("short_body")
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "JPEG" or max(image.size) > 1600:
                    raise ValueError("image_shape")
                inputs = processor(images=image.convert("RGB"), return_tensors="pt")
            with torch.inference_mode():
                values = torch.softmax(model(**inputs).logits, dim=-1)[0].tolist()
            score = next(values[i] for i, name in model.config.id2label.items() if name == "nsfw")
            self.answer(200, {"model": MODEL, "nsfw": score})
        except Exception:
            self.answer(503, {"error": "scan_failed"})
        finally:
            slot.release()

class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 4
    connections = threading.BoundedSemaphore(4)
    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise
    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()
    def handle_error(self, *_args):
        pass

Server(("0.0.0.0", 8000), Handler).serve_forever()
