// LDV-199 gaps: timing, redaction, evidence store with byte caps, ordered trace, /proc identity. Throwaway.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const MiB = 1024 * 1024
export const MAX_FRAME = 8388608
export const T0 = process.hrtime.bigint()
export const now = () => Number(process.hrtime.bigint() - T0) / 1e6
export const wallMs = () => Date.now()
export const sha256 = (b) => createHash("sha256").update(b).digest("hex")
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// fixed experimental bounds from the brief (not native guarantees)
export const W = { request: 5000, ready: 5000, ack: 5000, event: 10000, window: 10000 }

// ---------------- redaction (memory-only secrets) ----------------
const secretStrings = new Set()
const secretBufs = []
export function registerSecret(value) {
  if (typeof value !== "string" || value.length < 6 || secretStrings.has(value)) return
  secretStrings.add(value)
  secretBufs.push(Buffer.from(value, "utf8"))
}
export const containsSecret = (buf) => secretBufs.some((s) => buf.includes(s))
export function scrubText(s) {
  let out = s
  for (const sec of secretStrings) if (out.includes(sec)) out = out.split(sec).join("<redacted-secret>")
  return out
}
const SECRET_KEYS = new Set(["token", "ticket", "sealed", "password"])
export function scrub(v, depth = 0) {
  if (depth > 14) return "<depth-limit>"
  if (typeof v === "string") return scrubText(v)
  if (Buffer.isBuffer(v)) return `<buffer ${v.length}>`
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1))
  if (v && typeof v === "object") {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.has(k) && typeof x === "string" ? `<redacted len=${x.length} sha256_8=${sha256(x).slice(0, 8)}>` : scrub(x, depth + 1)
    return o
  }
  return v
}

// ---------------- evidence store with caps ----------------
export class Evidence {
  constructor(root, { totalCap = 128 * MiB, caseCap = 64 * MiB, reserve = 4 * MiB } = {}) {
    this.root = root
    this.totalCap = totalCap
    this.caseCap = caseCap
    this.reserveBytes = reserve
    this.total = 0
    this.perCase = new Map()
    this.limitHits = []
    fs.mkdirSync(root, { recursive: true })
  }
  abs(...rel) {
    const p = path.join(this.root, ...rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    return p
  }
  // bulk captures stop 4 MiB before the caps so results/cleanup always fit
  canCapture(caseName, n) {
    const c = this.perCase.get(caseName) ?? 0
    const ok = this.total + n <= this.totalCap - this.reserveBytes && c + n <= this.caseCap - this.reserveBytes
    if (!ok && !this.limitHits.includes(caseName)) this.limitHits.push(caseName)
    return ok
  }
  account(caseName, n) {
    this.total += n
    this.perCase.set(caseName, (this.perCase.get(caseName) ?? 0) + n)
  }
  // small structured writes (always scrubbed); counted against the hard caps
  writeJson(caseName, rel, obj) {
    const text = JSON.stringify(scrub(obj), null, 1)
    return this.writeBuf(caseName, rel, Buffer.from(text), true)
  }
  writeBuf(caseName, rel, buf, structured = false) {
    const c = this.perCase.get(caseName) ?? 0
    if (this.total + buf.length > this.totalCap || c + buf.length > this.caseCap) {
      this.limitHits.push(`${caseName}:${rel}:hard-cap`)
      return null
    }
    if (!structured && containsSecret(buf)) {
      this.limitHits.push(`${caseName}:${rel}:redaction-hit`)
      return null
    }
    const p = this.abs(rel)
    fs.writeFileSync(p, buf)
    this.account(caseName, buf.length)
    return { path: rel, bytes: buf.length, sha256: sha256(buf) }
  }
  appendLine(caseName, rel, obj) {
    const line = Buffer.from(JSON.stringify(scrub(obj)) + "\n")
    const c = this.perCase.get(caseName) ?? 0
    if (this.total + line.length > this.totalCap || c + line.length > this.caseCap) {
      this.limitHits.push(`${caseName}:${rel}:hard-cap`)
      return false
    }
    fs.appendFileSync(this.abs(rel), line)
    this.account(caseName, line.length)
    return true
  }
}

// ---------------- ordered trace ----------------
export class Trace {
  constructor(ev, rel = "trace.jsonl") {
    this.ev = ev
    this.rel = rel
    this.seq = 0
    this.caseName = "run"
    this.firstLaunchMs = null
  }
  add(kind, fields = {}) {
    const rec = { seq: this.seq++, t_ms: Math.round(now() * 1000) / 1000, wall_ms: wallMs(), case: this.caseName, kind, ...fields }
    if (this.firstLaunchMs !== null) rec.since_first_launch_ms = Math.round((now() - this.firstLaunchMs) * 1000) / 1000
    this.ev.appendLine("trace", this.rel, rec)
    return rec
  }
}

// ---------------- /proc identity ----------------
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
    const rest = stat.slice(close + 2).split(" ")
    const id = { pid, comm: stat.slice(stat.indexOf("(") + 1, close), state: rest[0], ppid: Number(rest[1]), starttime_ticks: Number(rest[19]), boot_id: bootID() }
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
export const sameIdentity = (rec, cur) => !!rec && !!cur && cur.pid === rec.pid && cur.starttime_ticks === rec.starttime_ticks && cur.boot_id === rec.boot_id
export function procState(rec) {
  const cur = rec ? procIdentity(rec.pid) : null
  if (!cur) return "gone"
  if (!sameIdentity(rec, cur)) return "pid-reused-or-boot-changed"
  return cur.state === "Z" ? "zombie" : cur.state === "X" ? "dead" : `alive:${cur.state}`
}
export const isAlive = (rec) => procState(rec).startsWith("alive")

export function inventoryDir(dir) {
  // nonsecret metadata only: names, types, sizes, modes, mtimes. Never contents.
  try {
    return fs.readdirSync(dir).sort().map((n) => {
      const st = fs.lstatSync(path.join(dir, n))
      return { name: n, type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isSocket() ? "socket" : st.isFile() ? "file" : "other", bytes: st.size, mode: (st.mode & 0o7777).toString(8), mtime_ms: Math.round(st.mtimeMs), uid: st.uid }
    })
  } catch (e) {
    return { error: e.code ?? e.message }
  }
}
