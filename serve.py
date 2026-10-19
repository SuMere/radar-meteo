#!/usr/bin/env python3
"""Server locale minimale per Radar Meteo.

Usa solo la libreria standard di Python: non installa nulla.
Ascolta esclusivamente su 127.0.0.1, serve solo i file dell'applicazione
(allowlist), solo in lettura (GET/HEAD) e aggiunge header di sicurezza.

Uso:  python3 serve.py [porta]                 solo questo computer (127.0.0.1:8765)
      python3 serve.py --host 0.0.0.0 --no-browser   raggiungibile dalla LAN
"""
import argparse
import http.server
import os
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))

ALLOWED = {
    "/index.html", "/css/style.css", "/js/app.js", "/js/sources.js", "/js/rating.js", "/js/util.js",
    "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css",
    "/vendor/leaflet/images/layers.png", "/vendor/leaflet/images/layers-2x.png",
    "/vendor/leaflet/images/marker-icon.png", "/vendor/leaflet/images/marker-icon-2x.png",
    "/vendor/leaflet/images/marker-shadow.png",
}
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
         ".js": "text/javascript; charset=utf-8", ".png": "image/png"}

def read_csp():
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        html = f.read()
    marker = 'http-equiv="Content-Security-Policy" content="'
    start = html.index(marker) + len(marker)
    return html[start:html.index('"', start)] + "; frame-ancestors 'none'"

CSP = read_csp()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "RadarMeteo"
    sys_version = ""

    def _send(self, head_only):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path == "/":
            path = "/index.html"
        if path not in ALLOWED:
            self.send_error(404)
            return
        full = os.path.realpath(os.path.join(ROOT, path.lstrip("/")))
        if not full.startswith(ROOT + os.sep):
            self.send_error(404)
            return
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", TYPES[os.path.splitext(full)[1]])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=(), usb=()")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def do_GET(self):
        self._send(False)

    def do_HEAD(self):
        self._send(True)

    def _deny(self):
        self.send_error(405)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _deny

    def log_message(self, fmt, *args):
        pass


def parse_args():
    ap = argparse.ArgumentParser(description="Server locale di Radar Meteo")
    ap.add_argument("port_pos", nargs="?", type=int, metavar="porta", help="porta (default 8765)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="indirizzo di ascolto: 127.0.0.1 (default, solo locale) o 0.0.0.0 (LAN)")
    ap.add_argument("--no-browser", action="store_true", help="non aprire il browser")
    a = ap.parse_args()
    if a.port_pos:
        a.port = a.port_pos
    if not 1 <= a.port <= 65535:
        ap.error("porta non valida")
    return a


def main():
    args = parse_args()
    httpd = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{shown}:{args.port}/"
    print(f"Radar Meteo in esecuzione su http://{args.host}:{args.port}/  (Ctrl+C per uscire)", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
