// Throwaway OpenCode-API-shaped shim over zeroclaw's native gateway. Everything here is adapter state/translation;
// nothing is claimed as native. Shim-generated values are marked origin:"shim" in emitted events' side log.
import { mono } from "./harness.mjs"

export function startShim({ nativeBase, agent, onTrace }) {
  const sessions = new Map()   // shimID -> {id, nativeID, title, created, ws, turn}
  const subscribers = new Set() // SSE controllers (adapter-buffered live fan-out only; NO replay buffer: see reconnect case)
  let evtSeq = 0
  const nid = (p) => p + crypto.randomUUID().replace(/-/g, "").slice(0, 20)
  const trace = (k, o) => onTrace?.({ mono_ms: mono(), kind: k, ...o })
  const emit = (type, properties, origin = "shim") => {
    const ev = { id: `evt_${String(++evtSeq).padStart(6, "0")}`, type, properties }
    trace("shim_event_out", { event: ev, origin, subscribers: subscribers.size })
    const frame = `data: ${JSON.stringify(ev)}\n\n`
    for (const s of subscribers) { try { s.enqueue(new TextEncoder().encode(frame)) } catch {} }
    return ev
  }
  const sessionObj = (s) => ({ id: s.id, slug: s.id.slice(4, 12), projectID: "global", directory: "/shim", title: s.title, version: "shim-0", time: { created: s.created, updated: Date.now() } })

  function turnState(s) { return (s.turn ??= { asstID: null, textPartID: null, text: "", tools: new Map() }) }
  function onNativeFrame(s, f) {
    const t = turnState(s)
    trace("native_frame_in", { session: s.id, frame: f })
    const ensureAssistant = () => {
      if (t.asstID) return
      t.asstID = nid("msg_"); emit("message.updated", { sessionID: s.id, info: { id: t.asstID, sessionID: s.id, role: "assistant", time: { created: Date.now() }, agent: agent } })
      emit("session.status", { sessionID: s.id, status: { type: "busy" } })
    }
    if (f.type === "chunk") {
      ensureAssistant()
      if (!t.textPartID) { t.textPartID = nid("prt_"); emit("message.part.updated", { sessionID: s.id, part: { id: t.textPartID, sessionID: s.id, messageID: t.asstID, type: "text", text: f.content }, time: Date.now() }) }
      else emit("message.part.delta", { sessionID: s.id, messageID: t.asstID, partID: t.textPartID, field: "text", delta: f.content })
      t.text += f.content
    } else if (f.type === "tool_call") {
      ensureAssistant(); const pid = nid("prt_"); t.tools.set(f.id, pid)
      emit("message.part.updated", { sessionID: s.id, part: { id: pid, sessionID: s.id, messageID: t.asstID, type: "tool", callID: f.id, tool: f.name, state: { status: "running", input: f.args, time: { start: Date.now() } } }, time: Date.now() })
    } else if (f.type === "tool_result") {
      ensureAssistant(); const pid = t.tools.get(f.id) ?? nid("prt_")
      emit("message.part.updated", { sessionID: s.id, part: { id: pid, sessionID: s.id, messageID: t.asstID, type: "tool", callID: f.id, tool: f.name, state: { status: "completed", output: f.output, time: { start: Date.now(), end: Date.now() } } }, time: Date.now() })
      t.textPartID = null // next text is a new part
    } else if (f.type === "done") {
      ensureAssistant(); emit("message.updated", { sessionID: s.id, info: { id: t.asstID, sessionID: s.id, role: "assistant", time: { created: Date.now(), completed: Date.now() }, finish: "stop" } })
      emit("session.status", { sessionID: s.id, status: { type: "idle" } }); emit("session.idle", { sessionID: s.id }); s.turn = null
    } else if (f.type === "aborted") {
      emit("session.error", { sessionID: s.id, error: { name: "MessageAbortedError", data: { message: "aborted (native frame)" } } })
      emit("session.status", { sessionID: s.id, status: { type: "idle" } }); emit("session.idle", { sessionID: s.id }); s.turn = null
    } else if (f.type === "error") {
      emit("session.error", { sessionID: s.id, error: { name: "UnknownError", data: { message: f.message, code: f.code } } }); s.turn = null
    }
  }

  async function ensureWs(s) {
    if (s.ws && s.ws.readyState === 1) return s.ws
    const url = nativeBase.replace("http", "ws") + `/ws/chat?agent=${agent}&session_id=${s.nativeID}`
    const ws = new WebSocket(url)
    s.wsOpen = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(new Error("ws error")) })
    ws.onmessage = (m) => { try { onNativeFrame(s, JSON.parse(m.data)) } catch (e) { trace("frame_parse_error", { err: String(e) }) } }
    ws.onclose = () => trace("native_ws_closed", { session: s.id })
    s.ws = ws; await s.wsOpen; return ws
  }
  const json = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json" } })

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url); const p = u.pathname; const m = req.method
      trace("shim_request", { m, p })
      if (m === "GET" && p === "/global/health") { const r = await fetch(nativeBase + "/health"); return json({ healthy: r.ok, version: "shim-0", native_status: r.status }) }
      if (m === "POST" && p === "/session") {
        const body = await req.json().catch(() => ({})); const id = nid("ses_")
        const s = { id, nativeID: crypto.randomUUID(), title: body.title ?? "New session", created: Date.now() }
        sessions.set(id, s); emit("session.created", { sessionID: id, info: sessionObj(s) }); return json(sessionObj(s))
      }
      if (m === "GET" && p === "/session") return json([...sessions.values()].map(sessionObj))
      let mm
      if ((mm = p.match(/^\/session\/([^/]+)$/)) && m === "GET") { const s = sessions.get(mm[1]); return s ? json(sessionObj(s)) : json({ name: "NotFoundError", data: {} }, 404) }
      if ((mm = p.match(/^\/session\/([^/]+)\/prompt_async$/)) && m === "POST") {
        const s = sessions.get(mm[1]); if (!s) return json({ name: "NotFoundError", data: {} }, 404)
        const body = await req.json(); const text = (body.parts ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n")
        const ws = await ensureWs(s)
        const userID = nid("msg_"); emit("message.updated", { sessionID: s.id, info: { id: userID, sessionID: s.id, role: "user", time: { created: Date.now() }, agent } })
        ws.send(JSON.stringify({ type: "message", content: text })); trace("native_frame_out", { session: s.id, frame: { type: "message", content_sha: new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16) } })
        return new Response(null, { status: 204 })
      }
      if ((mm = p.match(/^\/session\/([^/]+)\/message$/)) && m === "GET") {
        const s = sessions.get(mm[1]); if (!s) return json({ name: "NotFoundError", data: {} }, 404)
        const r = await fetch(`${nativeBase}/api/sessions/${s.nativeID}/messages`); const nat = await r.json()
        return json((nat.messages ?? []).map((x, i) => ({ info: { id: `msg_native_${i}`, sessionID: s.id, role: x.role, time: { created: Date.parse(x.created_at) || null } }, parts: [{ type: "text", text: x.content }], _origin: "native-persisted+shim-ids" })))
      }
      if ((mm = p.match(/^\/session\/([^/]+)\/abort$/)) && m === "POST") {
        const s = sessions.get(mm[1]); if (!s) return json(false, 200)
        const r = await fetch(`${nativeBase}/api/sessions/${s.nativeID}/abort`, { method: "POST" }); trace("native_abort_response", { status: r.status, body: (await r.text()).slice(0, 300) }); return json(r.ok)
      }
      if (m === "GET" && (p === "/event" || p === "/global/event")) {
        let ctrl
        const stream = new ReadableStream({ start(c) { ctrl = c; subscribers.add(c); c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${String(++evtSeq).padStart(6, "0")}`, type: "server.connected", properties: {} })}\n\n`)) }, cancel() { subscribers.delete(ctrl) } })
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
      }
      return json({ error: "not implemented in shim", path: p }, 501)
    },
  })
  return { server, port: server.port, sessions, subscribers, emit, close: () => { for (const s of sessions.values()) try { s.ws?.close() } catch {} ; server.stop(true) } }
}
