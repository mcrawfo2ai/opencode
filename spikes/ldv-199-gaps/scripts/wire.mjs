// LDV-199 gaps: frame-oriented socket with LOSSLESS raw receive capture (written before parsing).
// TX frames contain the credential token and are never stored. Wire declarations are local transcriptions of the
// pinned daemon.ts (protocol 7): uint32BE length + UTF-8 JSON {token,request}; output frame = tag 0 + uint64BE start/end + bytes.
import fs from "node:fs"
import net from "node:net"
import { MAX_FRAME, now, containsSecret } from "./lib.mjs"

export function encode(value) {
  const payload = Buffer.from(JSON.stringify(value))
  if (payload.length > MAX_FRAME) throw new Error("frame too large (client side)")
  const out = Buffer.allocUnsafe(payload.length + 4)
  out.writeUInt32BE(payload.length, 0)
  payload.copy(out, 4)
  return out
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v)
const isStr = (v) => typeof v === "string"
const nullable = (f) => (v) => v === null || f(v)
export function validateTerminal(t, p = "terminal") {
  const e = []
  if (!t || typeof t !== "object") return [`${p}: not an object`]
  const need = (k, f) => f(t[k]) || e.push(`${p}.${k}: bad`)
  need("id", isNum), need("pid", nullable(isNum)), need("title", isStr), need("foreground_process", nullable(isStr))
  need("group_id", isStr), need("command", (v) => Array.isArray(v) && v.every(isStr)), need("cwd", isStr)
  need("cols", isNum), need("rows", isNum), need("output_head", isNum), need("output_tail", isNum)
  const l = t.lifecycle
  if (!l || typeof l !== "object") e.push(`${p}.lifecycle: missing`)
  else if (l.status === "exited") {
    if (!("exit_code" in l) || !(l.exit_code === null || isNum(l.exit_code))) e.push(`${p}.lifecycle.exit_code: bad/absent`)
  } else if (l.status === "failed") isStr(l.message) || e.push(`${p}.lifecycle.message: bad`)
  else if (l.status !== "running") e.push(`${p}.lifecycle.status: unknown`)
  return e
}
export function validateWire(r) {
  if (!r || typeof r !== "object" || !isStr(r.type)) return ["not an object with string type"]
  const e = []
  const need = (k, f) => f(r[k]) || e.push(`${r.type}.${k}: bad`)
  switch (r.type) {
    case "pong": need("instance_id", isStr), need("pid", isNum), need("protocol", isNum); break
    case "created": e.push(...validateTerminal(r.terminal)); break
    case "terminals": Array.isArray(r.terminals) ? r.terminals.forEach((t, i) => e.push(...validateTerminal(t, `terminals[${i}]`))) : e.push("terminals: not array"); break
    case "ok": case "owned": break
    case "handoff": need("ticket", isStr), need("expires_at", isNum); break
    case "snapshot": e.push(...validateTerminal(r.terminal)); need("text", isStr), need("checkpoint_base64", isStr), need("cursor_x", isNum), need("cursor_y", isNum); break
    case "rows": e.push(...validateTerminal(r.terminal)); need("lines", (v) => Array.isArray(v) && v.every(isStr)); break
    case "attached":
      e.push(...validateTerminal(r.terminal))
      need("role", (v) => v === "controller" || v === "observer"), need("generation", isNum)
      need("requested_offset", isNum), need("available_offset", isNum), need("end_offset", isNum)
      need("truncated", (v) => typeof v === "boolean"), need("replay_base64", isStr)
      break
    case "resized": need("cols", isNum), need("rows", isNum), need("generation", isNum), need("checkpoint_base64", isStr); break
    case "exited": ("exit_code" in r && (r.exit_code === null || isNum(r.exit_code))) || e.push("exited.exit_code: bad/absent"); need("final_offset", isNum); break
    case "controller_changed": need("attachment_id", nullable(isStr)), need("generation", isNum); break
    case "title_changed": need("title", isStr); break
    case "foreground_process_changed": need("process", nullable(isStr)); break
    case "error": need("message", isStr); break
    default: e.push(`unknown response type: ${r.type}`)
  }
  return e
}

// online classification, used only for driver decisions; offline/verify.py re-derives everything independently
export function classifyFrame(buf) {
  if (buf.length > 0 && buf[0] === 0) {
    if (buf.length < 17) return { type: "output-invalid", problems: [`short output frame len=${buf.length}`] }
    const s = buf.readBigUInt64BE(1)
    const e = buf.readBigUInt64BE(9)
    const problems = []
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    if (s > max || e > max) problems.push("offset beyond safe integer")
    if (e < s) problems.push("end < start")
    const len = buf.length - 17
    if (!problems.length && Number(e) - Number(s) !== len) problems.push(`end-start=${Number(e) - Number(s)} != length ${len}`)
    return { type: "output", start: Number(s), end: Number(e), len, problems }
  }
  try {
    const text = buf.toString("utf8")
    const json = JSON.parse(text)
    return { type: "json", json, text, problems: validateWire(json) }
  } catch (err) {
    return { type: "json-invalid", problems: [String(err.message)] }
  }
}

export class Conn {
  // opts: label, socketPath, ev, caseName, rxRel (evidence-relative raw receive file, or null)
  constructor({ label, socketPath, ev, caseName, rxRel }) {
    Object.assign(this, { label, socketPath, ev, caseName, rxRel })
    this.queue = []
    this.waiters = []
    this.handler = null
    this.chunks = []
    this.total = 0
    this.need = null
    this.consumed = 0 // absolute rx offset of the next frame header
    this.broken = false
    this.localClose = false
    this.closeReason = null
    this.closed = false
    this.eof = false
    this.bytesIn = 0
    this.frames = 0
    this.rx = { path: rxRel, bytes: 0, lost: false, lostReason: null, fd: null }
  }
  open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error("connect timeout"))
      }, timeoutMs)
      socket.once("connect", () => {
        clearTimeout(timer)
        if (this.rxRel) this.rx.fd = fs.openSync(this.ev.abs(this.rxRel), "w")
        socket.on("data", (c) => this._data(c))
        socket.on("end", () => {
          this.eof = true
          this._deliver({ kind: "eof", t: now() })
          if (this.total !== 0 && !this.broken) this._deliver({ kind: "truncated-frame", pending: this.total, hdrOff: this.consumed, t: now() })
        })
        socket.on("error", (err) => this._deliver({ kind: "error", message: err.message, code: err.code, t: now() }))
        socket.on("close", (hadError) => {
          this.closed = true
          if (this.rx.fd !== null) {
            fs.closeSync(this.rx.fd)
            this.rx.fd = null
          }
          this._deliver({ kind: "close", hadError, local: this.localClose, reason: this.closeReason, t: now() })
        })
        resolve()
      })
      socket.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
  _capture(chunk) {
    if (this.rx.fd === null || this.rx.lost) return
    if (containsSecret(chunk)) {
      this.rx.lost = true
      this.rx.lostReason = "redaction-hit"
      return
    }
    if (!this.ev.canCapture(this.caseName, chunk.length)) {
      this.rx.lost = true
      this.rx.lostReason = "evidence-cap"
      return
    }
    fs.writeSync(this.rx.fd, chunk)
    this.ev.account(this.caseName, chunk.length)
    this.rx.bytes += chunk.length
  }
  _data(chunk) {
    this._capture(chunk) // lossless capture BEFORE any parsing
    if (this.broken) return
    this.bytesIn += chunk.length
    this.chunks.push(chunk)
    this.total += chunk.length
    for (;;) {
      if (this.need === null) {
        if (this.total < 4) return
        if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)]
        const len = this.chunks[0].readUInt32BE(0)
        if (len > MAX_FRAME) {
          this.broken = true
          this._deliver({ kind: "frame-limit", declared: len, hdrOff: this.consumed, t: now() })
          this.closeReason = "frame-limit"
          this.destroy("frame-limit")
          return
        }
        this.need = len + 4
      }
      if (this.total < this.need) return
      const all = this.chunks.length > 1 ? Buffer.concat(this.chunks) : this.chunks[0]
      const payload = all.subarray(4, this.need)
      const rest = all.subarray(this.need)
      const hdrOff = this.consumed
      this.consumed += this.need
      this.chunks = rest.length ? [rest] : []
      this.total = rest.length
      this.need = null
      this.frames++
      this._deliver({ kind: "frame", buf: payload, hdrOff, len: payload.length, t: now() })
    }
  }
  _deliver(item) {
    if (this.handler) return this.handler(item)
    const w = this.waiters.shift()
    if (w) return w(item)
    this.queue.push(item)
  }
  setHandler(fn) {
    this.handler = fn
    const q = this.queue
    this.queue = []
    for (const it of q) fn(it)
  }
  next(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift())
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve({ kind: "timeout", t: now() })
      }, timeoutMs)
      const w = (item) => {
        clearTimeout(timer)
        resolve(item)
      }
      this.waiters.push(w)
    })
  }
  write(token, request) {
    this.socket.write(encode({ token, request })) // credential-bearing: never stored
  }
  destroy(reason = "local") {
    if (!this.closed) {
      this.localClose = true
      this.closeReason = this.closeReason ?? reason
    }
    this.socket.destroy()
  }
}
