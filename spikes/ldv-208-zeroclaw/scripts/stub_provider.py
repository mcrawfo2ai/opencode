#!/usr/bin/env python3
"""Throwaway deterministic OpenAI-chat-completions stub for the ldv-208 spike (no real provider).

Protocol grounded in zeroclaw's own gateway test fixtures (lib.rs spawn_chat_completion_fixture*):
POST /v1/chat/completions -> text/event-stream of `data: {"choices":[{"delta":{...}}]}` frames when request.stream,
plain JSON otherwise. Gates are released ONLY by the case driver via POST /control/release.
Phase 1 (last message not a tool result): gate g1 -> marker text; gate g2 -> tool call (fixture file read).
Phase 2 (last message is a tool result):  gate g3 -> final text echoing a hash of the tool result.
"""
import hashlib, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT_FILE, FIXTURE_FILE, LOG_FILE = sys.argv[1], sys.argv[2], sys.argv[3]
cond = threading.Condition()
released = set()          # "g1:<marker>" or "g1:*"
seq = 0
log_lock = threading.Lock()
T0 = time.monotonic_ns()

def log(kind, **kw):
    global seq
    with log_lock:
        seq += 1
        rec = {"seq": seq, "mono_ms": round((time.monotonic_ns() - T0) / 1e6, 3), "kind": kind, **kw}
        with open(LOG_FILE, "a") as f: f.write(json.dumps(rec) + "\n")

def wait_gate(name, marker, timeout=60):
    log("gate_wait", gate=name, marker=marker)
    end = time.monotonic() + timeout
    with cond:
        while not ({f"{name}:{marker}", f"{name}:*"} & released):
            left = end - time.monotonic()
            if left <= 0:
                log("gate_timeout", gate=name, marker=marker); return False
            cond.wait(left)
    log("gate_open", gate=name, marker=marker); return True

def text_of(m):
    c = m.get("content")
    if isinstance(c, list): return "".join(p.get("text", "") for p in c if isinstance(p, dict))
    return c or ""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/v1/models": return self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]})
        if u.path == "/control/log":
            with log_lock: lines = [json.loads(l) for l in open(LOG_FILE)]
            return self._json(200, lines)
        self._json(404, {"error": "not found"})
    def do_POST(self):
        u = urlparse(self.path); n = int(self.headers.get("content-length") or 0); body = self.rfile.read(n)
        if u.path == "/control/release":
            q = parse_qs(u.query); g = q["gate"][0]; mk = q.get("marker", ["*"])[0]
            with cond: released.add(f"{g}:{mk}"); cond.notify_all()
            log("gate_release_ack", gate=g, marker=mk); return self._json(200, {"released": f"{g}:{mk}"})
        if u.path != "/v1/chat/completions": return self._json(404, {"error": "not found"})
        req = json.loads(body); msgs = req.get("messages", []); stream = bool(req.get("stream"))
        is_tr = lambda t: "<tool_result" in t or t.startswith("[Tool results]")
        users = [text_of(m) for m in msgs if m.get("role") == "user" and not is_tr(text_of(m))]
        prompt = users[-1] if users else ""
        marker = "MK-" + hashlib.sha256(prompt.encode()).hexdigest()[:12]
        nonsys = [m for m in msgs if m.get("role") != "system"]
        last = nonsys[-1] if nonsys else {}
        phase = 2 if (last.get("role") == "tool" or (last.get("role") == "user" and is_tr(text_of(last)))) else 1
        sysmsg = " ".join(text_of(m) for m in msgs if m.get("role") == "system"); i = sysmsg.find("file_read")
        tools = req.get("tools") or []
        tool_names = [t.get("function", {}).get("name") for t in tools]
        log("request_received", phase=phase, stream=stream, marker=marker, prompt_sha=hashlib.sha256(prompt.encode()).hexdigest()[:16],
            prompt_head=prompt[:200], roles=[m.get("role") for m in msgs], last_role=last.get("role"),
            tool_names=tool_names, last_tool_content_sha=(hashlib.sha256(text_of(last).encode()).hexdigest()[:16] if phase == 2 else None),
            last_tool_content_head=(text_of(last)[:200] if phase == 2 else None), system_file_read_excerpt=(sysmsg[max(0, i-80):i+260] if i >= 0 else None), system_tool_call_tag=("<tool_call>" in sysmsg), has_authorization=bool(self.headers.get("authorization")))
        fixture_path = open(FIXTURE_FILE).read().strip()
        def tool_call():
            schema = next((t["function"].get("parameters", {}) for t in tools if t.get("function", {}).get("name") == "file_read"), None)
            if schema is None:  # no native tools offered: zeroclaw's prompt-guided <tool_call> text protocol
                return {"text": "<tool_call>\n" + json.dumps({"name": "file_read", "arguments": {"path": fixture_path}}) + "\n</tool_call>"}
            props = (schema or {}).get("properties", {})
            args = {"path": fixture_path} if "path" in props else {next(iter(props), "path"): fixture_path}
            return {"id": "call_" + marker[3:], "type": "function", "function": {"name": "file_read", "arguments": json.dumps(args)}}
        if stream:
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("cache-control", "no-cache"); self.end_headers()
        def emit(delta, finish=None):
            frame = {"id": "chatcmpl-" + marker, "object": "chat.completion.chunk", "model": "stub-model",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode()); self.wfile.flush()
            log("emitted", marker=marker, delta_keys=list(delta.keys()), finish=finish)
        try:
            if phase == 1:
                if not wait_gate("g1", marker): return
                if not stream: pass
                else: emit({"role": "assistant", "content": f"MARKER {marker} reading fixture. "})
                if not wait_gate("g2", marker): return
                tc = tool_call()
                if stream:
                    if tc and "text" in tc: emit({"content": tc["text"]}, None); emit({}, "stop")
                    elif tc is None: emit({"content": "NO_FILE_READ_TOOL_OFFERED"}, "stop")
                    else: emit({"tool_calls": [{"index": 0, **tc}]}, None); emit({}, "tool_calls")
                    self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                else:
                    msg = {"role": "assistant", "content": f"MARKER {marker} reading fixture. "}
                    if tc and "text" in tc: msg["content"] += tc["text"]
                    elif tc: msg["tool_calls"] = [tc]
                    self._json(200, {"id": "chatcmpl-" + marker, "object": "chat.completion", "model": "stub-model",
                                     "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tc else "stop"}]})
            else:
                if not wait_gate("g3", marker): return
                final = f"FINAL {marker} tool_result_sha={hashlib.sha256(text_of(last).encode()).hexdigest()[:16]}"
                if stream:
                    emit({"role": "assistant", "content": final}, None); emit({}, "stop")
                    self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                else:
                    self._json(200, {"id": "chatcmpl-" + marker, "object": "chat.completion", "model": "stub-model",
                                     "choices": [{"index": 0, "message": {"role": "assistant", "content": final}, "finish_reason": "stop"}]})
        except (BrokenPipeError, ConnectionResetError):
            log("client_disconnected", marker=marker, phase=phase)

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORT_FILE, "w").write(str(srv.server_address[1]))
log("stub_started", port=srv.server_address[1])
srv.serve_forever()
