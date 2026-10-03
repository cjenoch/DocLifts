"""Run in classifier container. Generated solid-colour pixels only."""
import http.client
import io
import json
from PIL import Image
connection = http.client.HTTPConnection("127.0.0.1", 8000, timeout=10)
def call(body, mime="image/jpeg", declared=None):
    connection.request("POST", "/scan", body=body, headers={
        "Content-Type": mime, "Content-Length": str(len(body) if declared is None else declared)
    })
    response = connection.getresponse()
    status, data = response.status, response.read()
    connection.close()
    return status, json.loads(data)
image = Image.new("RGB", (400, 300), (40, 100, 160))
buffer = io.BytesIO()
image.save(buffer, format="JPEG")
status, result = call(buffer.getvalue())
assert status == 200 and 0 <= result["nsfw"] < 0.5, (status, result)
assert result["model"] == "Falconsai/nsfw_image_detection@96cb0d0342c7afb80cab76ecc58b265fa44da256"
assert call(b"not-an-image")[0] == 503
assert call(buffer.getvalue(), "image/png")[0] == 400
assert call(b"")[0] == 413
assert call(b"", declared=8 * 1024 * 1024 + 1)[0] == 413
print("PASS: real inference; malformed, MIME, empty and oversized refusals")
