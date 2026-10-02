// LDV-199 throwaway probe library: timing, redaction, trace, wire framing/validation, /proc identity.
// Plain ESM, no dependencies. Declarations are local wire declarations transcribed from the pinned
// packages/core/src/persistent-pty/daemon.ts (protocol 7); they are not imported from production code.
import { createHash } from "node:crypto"
import fs from "node:fs"
import net from "node:net"

export const MAX_FRAME = 8388608
export const T0 = process.hrtime.bigint()
export const now = () => Number(process.hrtime.bigint() - T0) / 1e6
export const wall = () => new Date().toISOString()
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- redaction ----------
const secrets = new Set()
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 6) secrets.add(value)
}
const SECRET_KEYS = new Set(["token", "ticket", "sealed", "password"])
export function scrub(value, depth = 0) {
  if (depth > 12) return "<depth-limit>"
  if (typeof value === "string") {
    let out = value
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join("<redacted-secret>")
    return out
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1))
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k) && typeof v === "string")
        out[k] = `<redacted len=${v.length} sha256_8=${sha256(v).slice(0, 8)}>`
      else out[k] = scrub(v, depth + 1)
    }
    return out
  }
  return value
}

// ---------- trace ----------
export class Trace {
  constructor(name, cap = 6000) {
    this.name = name
    this.events = []
    this.cap = cap
    this.dropped = 0
    this.seq = 0
  }
  add(kind, fields = {}) {
    const ev = { i: this.seq++, t_ms: Math.round(now() * 100) / 100, wall: wall(), kind, ...scrub(fields) }
    if (this.events.length >= this.cap) {
      this.dropped++
      return ev
    }
    this.events.push(ev)
    return ev
  }
}

// ---------- /proc identity ----------
export const bootID = () => {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  } catch {
    return null
  }
}
export function procIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const close = stat.lastIndexOf(")")
    const comm = stat.slice(stat.indexOf("(") + 1, close)
    const rest = stat.slice(close + 2).split(" ")
    // rest[0]=state(3) rest[1]=ppid(4) ... starttime is field 22 => rest[19]
    const id = { pid, comm, state: rest[0], ppid: Number(rest[1]), starttime_ticks: Number(rest[19]) }
    try {
      id.exe = fs.readlinkSync(`/proc/${pid}/exe`)
    } catch {
      id.exe = null
    }
    try {
      id.cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
    } catch {
      id.cmdline = null
    }
    return id
  } catch {
    return null
  }
}
// "alive" for our purposes: present and not a zombie. same: identity (starttime) still matches.
export const procAlive = (id) => {
  if (!id) return false
  const cur = procIdentity(id.pid)
  return !!cur && cur.starttime_ticks === id.starttime_ticks && cur.state !== "Z" && cur.state !== "X"
}
export const procState = (id) => {
  const cur = id ? procIdentity(id.pid) : null
  if (!cur) return "gone"
  if (cur.starttime_ticks !== id.starttime_ticks) return "pid-reused"
  return cur.state === "Z" ? "zombie" : cur.state === "X" ? "dead" : "alive:" + cur.state
}

// ---------- wire ----------
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
export function validateTerminal(t, path = "terminal") {
  const e = []
  if (!t || typeof t !== "object") return [`${path}: not an object`]
  const need = (k, f) => {
    if (!f(t[k])) e.push(`${path}.${k}: bad (${JSON.stringify(t[k])?.slice(0, 60)})`)
  }
  need("id", isNum)
  need("pid", nullable(isNum))
  need("title", isStr)
  need("foreground_process", nullable(isStr))
  need("group_id", isStr)
  need("command", (v) => Array.isArray(v) && v.every(isStr))
  need("cwd", isStr)
  need("cols", isNum)
  need("rows", isNum)
  need("output_head", isNum)
  need("output_tail", isNum)
  const l = t.lifecycle
  if (!l || typeof l !== "object") e.push(`${path}.lifecycle: missing`)
  else if (l.status === "running") {
    // ok
  } else if (l.status === "exited") {
    if (!("exit_code" in l) || !(l.exit_code === null || isNum(l.exit_code))) e.push(`${path}.lifecycle.exit_code: bad`)
  } else if (l.status === "failed") {
    if (!isStr(l.message)) e.push(`${path}.lifecycle.message: bad`)
  } else e.push(`${path}.lifecycle.status: unknown (${JSON.stringify(l.status)})`)
  return e
}
export function validateWire(r) {
  if (!r || typeof r !== "object" || !isStr(r.type)) return ["not an object with string type"]
  const e = []
  const need = (k, f) => {
    if (!f(r[k])) e.push(`${r.type}.${k}: bad (${JSON.stringify(r[k])?.slice(0, 60)})`)
  }
  switch (r.type) {
    case "pong":
      need("instance_id", isStr)
      need("pid", isNum)
      need("protocol", isNum)
      break
    case "created":
      e.push(...validateTerminal(r.terminal))
      break
    case "terminals":
      if (!Array.isArray(r.terminals)) e.push("terminals: not array")
      else r.terminals.forEach((t, i) => e.push(...validateTerminal(t, `terminals[${i}]`)))
      break
    case "ok":
    case "owned":
      break
    case "handoff":
      need("ticket", isStr)
      need("expires_at", isNum)
      break
    case "snapshot":
      e.push(...validateTerminal(r.terminal))
      need("text", isStr)
      need("checkpoint_base64", isStr)
      need("cursor_x", isNum)
      need("cursor_y", isNum)
      break
    case "rows":
      e.push(...validateTerminal(r.terminal))
      need("lines", (v) => Array.isArray(v) && v.every(isStr))
      need("cursor_x", isNum)
      need("cursor_y", isNum)
      break
    case "attached":
      e.push(...validateTerminal(r.terminal))
      need("role", (v) => v === "controller" || v === "observer")
      need("generation", isNum)
      need("requested_offset", isNum)
      need("available_offset", isNum)
      need("end_offset", isNum)
      need("truncated", (v) => typeof v === "boolean")
      need("replay_base64", isStr)
      break
    case "resized":
      need("cols", isNum)
      need("rows", isNum)
      need("generation", isNum)
      need("checkpoint_base64", isStr)
      break
    case "exited":
      if (!("exit_code" in r) || !(r.exit_code === null || isNum(r.exit_code))) e.push("exited.exit_code: bad")
      need("final_offset", isNum)
      break
    case "controller_changed":
      need("attachment_id", nullable(isStr))
      need("generation", isNum)
      break
    case "title_changed":
      need("title", isStr)
      break
    case "foreground_process_changed":
      need("process", nullable(isStr))
      break
    case "error":
      need("message", isStr)
      break
    default:
      e.push(`unknown response type: ${r.type}`)
  }
  return e
}

// Classify one stream frame: tag-0 output (uint64BE start@1, end@9, raw bytes @17) or JSON.
export function classifyFrame(buf) {
  if (buf.length > 0 && buf[0] === 0) {
    const problems = []
    if (buf.length < 17) return { type: "output-invalid", problems: [`short output frame len=${buf.length}`] }
    const s = buf.readBigUInt64BE(1)
    const e = buf.readBigUInt64BE(9)
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    if (s > max || e > max) problems.push("offset beyond safe integer")
    if (e < s) problems.push("end < start")
    const start = Number(s)
    const end = Number(e)
    const len = buf.length - 17
    if (!problems.length && end - start !== len) problems.push(`end-start=${end - start} != payload length ${len}`)
    return { type: "output", start, end, len, data: buf.subarray(17), problems }
  }
  try {
    const json = JSON.parse(buf.toString("utf8"))
    return { type: "json", json, problems: validateWire(json) }
  } catch (err) {
    return { type: "json-invalid", problems: [String(err.message)] }
  }
}

// Frame-oriented connection. Items: {kind:'frame',buf} | 'eof' | 'error' | 'close' | 'frame-limit' | 'truncated-frame'.
export class Conn {
  constructor(label, socketPath, trace) {
    this.label = label
    this.socketPath = socketPath
    this.trace = trace
    this.queue = []
    this.waiters = []
    this.handler = null
    this.chunks = []
    this.total = 0
    this.need = null
    this.broken = false
    this.localClose = false
    this.closed = false
    this.eof = false
    this.bytesIn = 0
    this.frames = 0
  }
  open(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error("connect timeout"))
      }, timeoutMs)
      socket.once("connect", () => {
        clearTimeout(timer)
        socket.on("data", (c) => this._data(c))
        socket.on("end", () => {
          this.eof = true
          this._deliver({ kind: "eof", t: now() })
          if (this.total !== 0 && !this.broken) this._deliver({ kind: "truncated-frame", pending: this.total, t: now() })
        })
        socket.on("error", (err) => this._deliver({ kind: "error", message: err.message, code: err.code, t: now() }))
        socket.on("close", (hadError) => {
          this.closed = true
          this._deliver({ kind: "close", hadError, local: this.localClose, t: now() })
        })
        resolve()
      })
      socket.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
  _data(chunk) {
    if (this.broken) return
    this.bytesIn += chunk.length
    this.chunks.push(chunk)
    this.total += chunk.length
    for (;;) {
      if (this.need === null) {
        if (this.total < 4) return
        if (this.chunks.length > 1) {
          this.chunks = [Buffer.concat(this.chunks)]
        }
        const len = this.chunks[0].readUInt32BE(0)
        if (len > MAX_FRAME) {
          this.broken = true
          this._deliver({ kind: "frame-limit", length: len, t: now() })
          this.socket.destroy()
          return
        }
        this.need = len + 4
      }
      if (this.total < this.need) return
      const all = this.chunks.length > 1 ? Buffer.concat(this.chunks) : this.chunks[0]
      const frame = all.subarray(4, this.need)
      const rest = all.subarray(this.need)
      this.chunks = rest.length ? [rest] : []
      this.total = rest.length
      this.need = null
      this.frames++
      this._deliver({ kind: "frame", buf: frame, t: now() })
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
    for (const item of q) fn(item)
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
    this.socket.write(encode({ token, request }))
  }
  destroy() {
    if (!this.closed) this.localClose = true
    this.socket.destroy()
  }
}
