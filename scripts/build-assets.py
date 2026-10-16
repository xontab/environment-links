"""Render the extension icons and Chrome Web Store images with headless Chrome.

    python3 scripts/build-assets.py

Sources live in store/source/; output goes to icons/ and store/.
"""
import base64, functools, http.server, json, pathlib, shutil, struct, subprocess, tempfile, threading, zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "store" / "source"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ICON = (SRC / "icon.svg").read_text()
ICON_URI = "data:image/svg+xml;base64," + base64.b64encode(ICON.encode()).decode()


# The settings page needs a real origin (ES modules) and a stand-in for chrome.storage,
# so serve a copy of src/ with a seeded stub from a throwaway local server.
SITE = pathlib.Path(tempfile.mkdtemp())
shutil.copytree(ROOT / "src", SITE, dirs_exist_ok=True)
SEED = {
    "openIn": "currentTab",
    "variableNames": ["ENVIRONMENT", "DOMAIN"],
    "globals": {"DOMAIN": "example.com"},
    "environments": [
        {"id": "dev", "name": "DEV", "variables": {"ENVIRONMENT": "dev"}},
        {"id": "staging", "name": "STAGING", "variables": {"ENVIRONMENT": "staging"}},
        {"id": "preprod", "name": "PREPROD", "variables": {"ENVIRONMENT": "preprod"}},
        {"id": "production", "name": "PRODUCTION", "variables": {}},
    ],
    "links": [
        {"key": "backoffice", "template": "backoffice.{{ENVIRONMENT}}.{{DOMAIN}}",
         "overrides": {"production": "backoffice.{{DOMAIN}}"}},
        {"key": "grafana", "template": "grafana.{{ENVIRONMENT}}.{{DOMAIN}}",
         "overrides": {"production": "grafana.{{DOMAIN}}"}},
        {"key": "api-docs", "template": "api-{{ENVIRONMENT}}.{{DOMAIN}}/swagger",
         "overrides": {"production": "api.{{DOMAIN}}/swagger"}},
    ],
}
STUB = ("<script>const mem={config:%s};window.chrome={runtime:{getManifest:()=>({omnibox:{keyword:'e'}})},"
        "storage:{sync:{get:async k=>({[k]:mem[k]}),set:async o=>Object.assign(mem,o)},onChanged:{addListener(){}}}};"
        "addEventListener('load',()=>setTimeout(()=>document.querySelector('.toggle')?.click(),100));</script>") % json.dumps(SEED)
for page in ("options.html", "popup.html"):
    path = SITE / page
    path.write_text(path.read_text().replace('<script type="module"', STUB + '<script type="module"'))
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


handler = functools.partial(Quiet, directory=SITE)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}"


def crop_png(path, w, h):
    """Crop an 8-bit RGBA PNG to its top-left w x h (no imaging library needed)."""
    data = path.read_bytes()
    pos, chunks = 8, []
    while pos < len(data):
        n = struct.unpack(">I", data[pos:pos + 4])[0]
        chunks.append((data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]))
        pos += n + 12
    ihdr = dict(chunks)[b"IHDR"]
    width, height, depth, ctype = struct.unpack(">IIBB", ihdr[:10])
    if (width, height) == (w, h):
        return
    assert depth == 8 and ctype in (2, 6), "unexpected PNG format"
    bpp = 4 if ctype == 6 else 3
    raw = zlib.decompress(b"".join(d for t, d in chunks if t == b"IDAT"))
    stride, prev, rows = width * bpp, bytearray(width * bpp), []
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(b"\x00" + bytes(line[:w * bpp]))
        prev = line
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">II", w, h) + ihdr[8:])
                     + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def shoot(html, out, w, h):
    # Headless Chrome has a minimum window width (~500px), so pin the page size and
    # render into a window at least that wide; the screenshot is then cropped to w x h.
    pin = f'<meta charset="utf-8"><style>html{{background:transparent}}body{{width:{w}px;height:{h}px;overflow:hidden}}</style>'
    with tempfile.TemporaryDirectory() as tmp:
        page = SITE / f"{out.stem}.html"
        page.write_text(pin + html)
        subprocess.run(
            [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
             "--default-background-color=00000000", "--blink-settings=preferredColorScheme=1", f"--window-size={max(w, 600)},{h}",
             f"--user-data-dir={tmp}/profile", "--virtual-time-budget=2000", f"--screenshot={out}", f"{BASE}/{page.name}"],
            check=True, capture_output=True,
        )
    crop_png(out, w, h)
    print(f"{out.relative_to(ROOT)}  {w}x{h}")


def icon_page(size, pad):
    inner = size - 2 * pad
    return (f"<html><body style='margin:0;background:transparent'>"
            f"<img src='{ICON_URI}' width='{inner}' height='{inner}' style='display:block;margin:{pad}px'></body></html>")


# Extension icons: full bleed at small sizes; 128 uses Google's 96px artwork + 16px padding.
for size, pad in ((16, 0), (32, 0), (48, 2), (128, 16)):
    shoot(icon_page(size, pad), ROOT / "icons" / f"icon{size}.png", size, size)
shoot(icon_page(128, 16), ROOT / "store" / "store-icon-128.png", 128, 128)

css = (SRC / "common.css").read_text()
for name in ("promo-small", "promo-marquee", "screenshot-1", "screenshot-2", "screenshot-3", "screenshot-4"):
    src = SRC / f"{name}.html"
    if not src.exists():
        continue
    html = src.read_text().replace("{{CSS}}", css).replace("{{ICON}}", ICON_URI)
    w, h = (int(v) for v in html.split("<!--size:")[1].split("-->")[0].split("x"))
    shoot(html, ROOT / "store" / f"{name}.png", w, h)

server.shutdown()
shutil.rmtree(SITE)
