#!/usr/bin/env python3
"""
Simple static file server with COOP/COEP headers.

The kisakcod-sp.js worker code uses SharedArrayBuffer, which requires
the page to be "cross-origin isolated". Browsers only allow that when
the response includes:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

A plain `python3 -m http.server` does not send these headers, which is
why you saw:

    DataCloneError: Failed to execute 'postMessage' on 'Worker':
    SharedArrayBuffer transfer requires self.crossOriginIsolated.

Usage:
    python3 server.py [port]

Then open http://localhost:<port>/ (default port 8000).
"""

import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CrossOriginIsolatedHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # Helps avoid stale cached copies of the wasm/js while testing.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # Make sure .wasm is served with the correct MIME type; some
    # platforms' mimetypes module doesn't know it by default.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
    }


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = HTTPServer(("0.0.0.0", port), CrossOriginIsolatedHandler)
    print(f"Serving on http://localhost:{port}/ with COOP/COEP headers (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
        server.server_close()


if __name__ == "__main__":
    main()
