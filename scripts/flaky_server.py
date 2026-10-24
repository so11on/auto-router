#!/usr/bin/env python3
"""Test fixture: an OpenAI-compatible server that streams two chunks and then drops the connection.

Used to prove that the gateway continues a half-written answer on another model.
Run:  python3 scripts/flaky_server.py            (listens on 0.0.0.0:4199 so the LiteLLM container can reach it;
                                                   stop it when the test is over)
Then: curl localhost:4000/v1/chat/completions -H "Authorization: Bearer $LITELLM_MASTER_KEY" \\
        -d '{"model":"test-flaky","stream":true,"messages":[{"role":"user","content":"Count from 1 to 20"}]}'
"""
import json
import socket
import struct
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        for piece in ("1, 2, 3, ", "4, 5, 6, "):
            body = "data: " + json.dumps({"id": "x", "object": "chat.completion.chunk", "model": "flaky",
                                          "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}) + "\n\n"
            self.wfile.write(f"{len(body.encode()):x}\r\n{body}\r\n".encode())
            self.wfile.flush()
            time.sleep(0.2)
        # abort without the terminating chunk: the client sees a broken stream, not a clean end
        self.request.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        self.request.shutdown(socket.SHUT_RDWR)
        self.request.close()
        self.close_connection = True

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 4199), Handler).serve_forever()
