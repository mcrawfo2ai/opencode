// Throwaway harness for the ldv-208 spike: isolated launch, process identity, bounded evidence.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import net from "node:net"

export const T0 = performance.now()
export const mono = () => Math.round((performance.now() - T0) * 1000) / 1000
const MAX_TOTAL = 60 * 1024 * 1024 // 64 MiB minus 4 MiB reserve
const MAX_FRAME = 1024 * 1024

export class Evidence {
  constructor(dir) { this.dir = dir; this.total = 0; this.truncations = []; fs.mkdirSync(dir, { recursive: true }) }
  // Redact bearer tokens / pairing codes defensively before anything is written.
  redact(s) { return s.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/g, "$1[REDACTED]").replace(/("(?:token|password|secret|pairing_code|api_key)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"') }
  write(name, obj) {
    let s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 1)
    s = this.redact(s)
    if (Buffer.byteLength(s) > MAX_FRAME) { this.truncations.push({ name, bytes: Buffer.byteLength(s) }); s = s.slice(0, MAX_FRAME) + "\n[TRUNCATED-BY-INSTRUMENT]" }
    if (this.total + Buffer.byteLength(s) > MAX_TOTAL) throw new Error("evidence budget exceeded: instrument invalid")
    this.total += Buffer.byteLength(s)
    fs.writeFileSync(path.join(this.dir, name), s)
    return crypto.createHash("sha256").update(s).digest("hex")
  }
  append(name, obj) { const s = this.redact(JSON.stringify(obj)) + "\n"; this.total += Buffer.byteLength(s); fs.appendFileSync(path.join(this.dir, name), s) }
}

export function procIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return { pid, starttime_ticks: after[19], cmdline: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).slice(0, 8).join(" ") }
  } catch { return null }
}

export async function freePort() {
  return await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)) }) })
}

export const owned = [] // {name, proc, identity}
// Minimal child env allowlist: no inherited cloud/GitHub/provider secrets or proxy settings.
export function spawnOwned(name, cmd, args, env, logFile) {
  const out = fs.openSync(logFile, "a")
  const proc = Bun.spawn([cmd, ...args], { env, stdout: out, stderr: out, stdin: "ignore" })
  const identity = procIdentity(proc.pid)
  owned.push({ name, proc, identity, cmd: [cmd, ...args].join(" ") })
  return { proc, identity }
}

export async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) { try { const v = await fn(); if (v) return v } catch {} ; if (Date.now() > end) throw new Error(`deadline ${ms}ms: ${what}`); await Bun.sleep(100) }
}

export async function cleanup(ev) {
  const report = []
  for (const o of owned.reverse()) {
    const now = procIdentity(o.proc.pid)
    const same = now && now.starttime_ticks === o.identity?.starttime_ticks
    const row = { name: o.name, pid: o.proc.pid, identity_recorded: o.identity, identity_matches_before_signal: !!same }
    if (same) { o.proc.kill("SIGTERM"); const t = Date.now(); while (procIdentity(o.proc.pid)?.starttime_ticks === o.identity.starttime_ticks && Date.now() - t < 5000) await Bun.sleep(100)
      if (procIdentity(o.proc.pid)?.starttime_ticks === o.identity.starttime_ticks) { row.escalated = true; o.proc.kill("SIGKILL"); await Bun.sleep(300) } }
    row.exit = await Promise.race([o.proc.exited, Bun.sleep(1000).then(() => "not-reaped")])
    row.alive_after = !!(procIdentity(o.proc.pid)?.starttime_ticks === o.identity?.starttime_ticks)
    report.push(row)
  }
  return report
}
