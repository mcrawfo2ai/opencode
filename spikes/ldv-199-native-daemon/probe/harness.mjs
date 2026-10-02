// LDV-199 harness: Daemon launcher/requester, Fixture (gate/ack/oracle), Sub (stream subscriber). Throwaway.
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Conn, Trace, now, wall, sleep, sha256, scrub, registerSecret, procIdentity, procAlive, procState, classifyFrame } from "./lib.mjs"

export const ROOT = "/tmp/r" // inside the private /tmp bind (disk-backed workspace scratch)
export const T = { request: 5000, ready: 5000, event: 10000 }
export const PROBE_DIR = path.dirname(new URL(import.meta.url).pathname)

export class Ctx {
  constructor() {
    this.trace = new Trace("startup")
    this.conns = new Set()
    this.daemons = []
    this.fixtures = []
    this.subs = []
    this.order = []
    this.deadline = null
    this.connSeq = 0
  }
  newConn(label, daemon) {
    const c = new Conn(label, daemon.reg.socket, this.trace)
    this.conns.add(c)
    return c
  }
  guard(label) {
    if (this.deadline && now() > this.deadline) throw new Error(`deadline: no new actions (${label})`)
  }
}

// ---- compact views for traces ----
export const tsum = (t) =>
  t && {
    id: t.id,
    pid: t.pid,
    fg: t.foreground_process,
    group: t.group_id,
    lifecycle: t.lifecycle,
    head: t.output_head,
    tail: t.output_tail,
    cols: t.cols,
    rows: t.rows,
  }
export function compactResp(r) {
  if (!r || typeof r !== "object") return r
  const out = {}
  for (const [k, v] of Object.entries(r)) {
    if (k === "terminal") out.terminal = tsum(v)
    else if (k === "terminals") out.terminals = v.map(tsum)
    else if (typeof v === "string" && v.length > 200) out[k] = { len: v.length, sha256_8: sha256(v).slice(0, 8), head: v.slice(0, 60) }
    else out[k] = v
  }
  return out
}

// ---- Daemon ----
export class Daemon {
  constructor(ctx, tag, exe) {
    this.ctx = ctx
    this.tag = tag
    this.exe = exe
    this.seq = 0
    this.owner = null
    this.exitInfo = null
  }
  get t() {
    return this.ctx.trace
  }
  async launch() {
    const ctx = this.ctx
    ctx.guard("daemon launch")
    this.rt = path.join(ROOT, `rt-${this.tag}`)
    fs.mkdirSync(this.rt, { recursive: true, mode: 0o700 })
    const home = path.join(ROOT, "home")
    this.env = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "xdg/config"),
      XDG_DATA_HOME: path.join(home, "xdg/data"),
      XDG_CACHE_HOME: path.join(home, "xdg/cache"),
      XDG_RUNTIME_DIR: path.join(home, "xdg/runtime"),
      OPENCODE_PTY_RUNTIME_DIR: this.rt,
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
    }
    for (const d of Object.values(this.env).filter((v) => v.startsWith(home))) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const t0 = now()
    const child = spawn(this.exe, ["daemon"], { detached: true, stdio: "ignore", env: this.env })
    await new Promise((res, rej) => {
      child.once("spawn", res)
      child.once("error", rej)
    })
    child.unref()
    this.child = child
    child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal, t_ms: Math.round(now()), wall: wall() }
      this.t.add("daemon-exit-event", { daemon: this.tag, ...this.exitInfo })
    })
    this.procId = procIdentity(child.pid)
    ctx.daemons.push(this)
    let reg
    const until = now() + T.ready
    let lastErr
    while (now() < until) {
      try {
        reg = JSON.parse(fs.readFileSync(path.join(this.rt, "service.json"), "utf8"))
        break
      } catch (e) {
        lastErr = e.message
        await sleep(50)
      }
    }
    if (!reg) throw new Error(`daemon registration not found within ${T.ready}ms: ${lastErr}`)
    registerSecret(reg.token)
    this.reg = reg
    this.instance_id = reg.instance_id
    const ping = await this.oneShot({ op: "ping" }, { label: "ping-launch" })
    this.identity = {
      tag: this.tag,
      spawned_pid: child.pid,
      registration: { instance_id: reg.instance_id, pid: reg.pid, protocol: reg.protocol, socket: reg.socket, token: "<in-memory only>" },
      registration_keys: Object.keys(reg).sort(),
      registration_pid_equals_spawned_pid: reg.pid === child.pid,
      protocol_is_7: reg.protocol === 7,
      ping: ping.resp,
      ping_matches_registration:
        ping.resp?.type === "pong" && ping.resp.instance_id === reg.instance_id && ping.resp.pid === reg.pid && ping.resp.protocol === 7,
      proc: this.procId,
      runtime_dir: this.rt,
      env_keys: Object.keys(this.env).sort(),
      ready_ms: Math.round(now() - t0),
    }
    this.t.add("daemon-launched", { daemon: this.tag, identity: this.identity })
    if (!this.identity.ping_matches_registration) throw new Error("ping does not match registration")
    this.owner = await this.openOwner()
    return this
  }
  async openOwner(ticket) {
    const ctx = this.ctx
    const conn = ctx.newConn(`owner-${this.tag}-${++this.seq}`, this)
    await conn.open(T.request)
    const req = { op: "own", instance_id: this.reg.instance_id, ...(ticket ? { ticket } : {}) }
    this.t.add("request", { conn: conn.label, op: "own", request: req })
    conn.write(this.reg.token, req)
    const item = await conn.next(T.request)
    const c = item.kind === "frame" ? classifyFrame(item.buf) : null
    const resp = c?.json ?? { failure: item.kind, ...item }
    this.t.add("response", { conn: conn.label, response: compactResp(resp), problems: c?.problems })
    conn.setHandler((it) => this.t.add("owner-item", { conn: conn.label, item: it.kind === "frame" ? "frame" : it.kind, ...(it.kind === "frame" ? { len: it.buf.length } : { hadError: it.hadError, local: it.local, message: it.message }) }))
    if (resp.type !== "owned") throw new Error(`own failed: ${JSON.stringify(compactResp(resp))}`)
    return { conn, resp }
  }
  async ownerExchange(owner, request) {
    this.t.add("request", { conn: owner.conn.label, op: request.op, request })
    owner.conn.handler = null
    owner.conn.write(this.reg.token, request)
    const item = await owner.conn.next(T.request)
    const c = item.kind === "frame" ? classifyFrame(item.buf) : null
    owner.conn.setHandler((it) => this.t.add("owner-item", { conn: owner.conn.label, item: it.kind, hadError: it.hadError, local: it.local }))
    const resp = c?.json ?? { failure: item.kind }
    this.t.add("response", { conn: owner.conn.label, response: compactResp(resp), problems: c?.problems })
    return { resp, problems: c?.problems ?? [] }
  }
  // One request on its own connection (like the client's oneShot). Never retried here.
  async oneShot(request, { label, record = true, timeout = T.request } = {}) {
    this.ctx.guard(`request ${request.op}`)
    const conn = this.ctx.newConn(label ?? `req-${this.tag}-${++this.seq}`, this)
    const t0 = now()
    const out = { conn: conn.label, op: request.op }
    try {
      await conn.open(timeout)
    } catch (e) {
      out.failure = "connect"
      out.message = e.message
      out.code = e.code
      if (record) this.t.add("request-failed", out)
      return out
    }
    if (record) this.t.add("request", { conn: conn.label, op: request.op, request })
    conn.write(this.reg.token, request)
    const item = await conn.next(timeout)
    out.rtt_ms = Math.round((now() - t0) * 100) / 100
    if (item.kind === "frame") {
      const c = classifyFrame(item.buf)
      out.resp = c.json
      out.problems = c.problems
      out.frameType = c.type
    } else {
      out.failure = item.kind
      out.detail = { hadError: item.hadError, message: item.message, length: item.length }
    }
    conn.destroy()
    if (record) this.t.add("response", { conn: conn.label, rtt_ms: out.rtt_ms, response: out.resp && compactResp(out.resp), failure: out.failure, detail: out.detail, problems: out.problems?.length ? out.problems : undefined })
    return out
  }
  async list(opts = {}) {
    const r = await this.oneShot({ op: "list" }, opts)
    r.terminals = r.resp?.type === "terminals" ? r.resp.terminals : null
    return r
  }
  async find(id, opts) {
    const r = await this.list(opts)
    r.terminal = r.terminals?.find((t) => t.id === id) ?? null
    return r
  }
  readRegistration() {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(this.rt, "service.json"), "utf8"))
      registerSecret(reg.token)
      return reg
    } catch (e) {
      return { error: e.message }
    }
  }
}

// ---- Fixture ----
export class Fixture {
  constructor(ctx, daemon, name, code = 0) {
    this.ctx = ctx
    this.daemon = daemon
    this.name = name
    this.code = code
    this.dir = path.join(ROOT, "fx", `${name}-${process.pid}`)
    fs.rmSync(this.dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(this.dir, "gates"), { recursive: true })
    fs.mkdirSync(path.join(this.dir, "acks"), { recursive: true })
    this.oraclePath = path.join(this.dir, "oracle.bin")
    fs.writeFileSync(this.oraclePath, "")
    this.group = `ldv199-${name}-${process.pid}`
    this.released = []
    ctx.fixtures.push(this)
  }
  static stdSteps(name, code) {
    return [
      { op: "mode" },
      { op: "emit", text: `READY ${name}\n` },
      { op: "ack", name: "ready" },
      { op: "gate", name: "start" },
      { op: "emit", text: `START ${name}\n` },
      { op: "ack", name: "started" },
      { op: "gate", name: "mid" },
      { op: "emit", text: `MID ${name}\n` },
      { op: "ack", name: "mid-emitted" },
      { op: "gate", name: "exit" },
      { op: "emit", text: `FINAL ${name}\n` },
      { op: "ack", name: "exit-stage", extra: { code } },
      { op: "exit", code },
    ]
  }
  async create(steps, { program, args } = {}) {
    const ctx = this.ctx
    const scenarioPath = path.join(this.dir, "scenario.json")
    if (!program) {
      fs.writeFileSync(scenarioPath, JSON.stringify({ name: this.name, dir: this.dir, steps: steps ?? Fixture.stdSteps(this.name, this.code) }))
      program = process.execPath
      args = [path.join(PROBE_DIR, "fixture.mjs"), scenarioPath]
    }
    this.env = { PATH: "/usr/bin:/bin", HOME: path.join(ROOT, "home"), TERM: "xterm", LANG: "C.UTF-8", TMPDIR: "/tmp" }
    const req = { op: "create", program, args, cwd: this.dir, title: `ldv199-${this.name}`, group_id: this.group, env: this.env, cols: 80, rows: 24 }
    const r = await this.daemon.oneShot(req, { label: `create-${this.name}` })
    if (r.resp?.type !== "created") throw new Error(`create failed: ${JSON.stringify(compactResp(r.resp) ?? r)}`)
    this.terminal = r.resp.terminal
    this.ptyId = r.resp.terminal.id
    this.pid = r.resp.terminal.pid
    this.procId = procIdentity(this.pid)
    this.instance_id = this.daemon.instance_id
    this.created_wall = Date.now()
    ctx.trace.add("fixture-created", { fx: this.name, ptyId: this.ptyId, pid: this.pid, group: this.group, instance_id: this.instance_id, proc: this.procId, createResponse: compactResp(r.resp) })
    return this
  }
  release(gate) {
    fs.writeFileSync(path.join(this.dir, "gates", gate), "")
    this.released.push(gate)
    const ev = { kind: "gate-release", fx: this.name, name: gate }
    this.ctx.order.push(ev)
    this.ctx.trace.add("gate-release", { fx: this.name, name: gate, wall_ms: Date.now() })
  }
  releaseAll() {
    let names = ["start", "mid", "exit", "outer", "child"]
    try {
      const sc = JSON.parse(fs.readFileSync(path.join(this.dir, "scenario.json"), "utf8"))
      names = names.concat(sc.steps.filter((x) => x.op === "gate").map((x) => x.name))
    } catch {}
    for (const g of names) {
      try {
        fs.writeFileSync(path.join(this.dir, "gates", g), "")
      } catch {}
    }
  }
  async ack(name, timeoutMs = T.ready) {
    const file = path.join(this.dir, "acks", `${name}.json`)
    const until = now() + timeoutMs
    while (now() < until) {
      try {
        const a = JSON.parse(fs.readFileSync(file, "utf8"))
        a.observed_wall_ms = Date.now()
        this.ctx.order.push({ kind: "ack", fx: this.name, name })
        this.ctx.trace.add("ack", { fx: this.name, name, ack: a })
        return a
      } catch {
        await sleep(10)
      }
    }
    this.ctx.trace.add("ack-timeout", { fx: this.name, name, timeoutMs })
    return null
  }
  readAck(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "acks", `${name}.json`), "utf8"))
    } catch {
      return null
    }
  }
  oracle() {
    return fs.readFileSync(this.oraclePath)
  }
  oracleAfterOrigin() {
    return this.oracle().subarray(this.preLen)
  }
  // Origin = native output_tail observed while the start gate is still closed (no subscription needed).
  async captureOrigin() {
    const ready = await this.ack("ready")
    if (!ready) throw new Error("fixture ready ack timed out")
    this.preLen = ready.oracle_len
    const mode = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this.dir, "mode.json"), "utf8"))
      } catch {
        return null
      }
    })()
    this.mode = mode
    let last = null
    let stable = 0
    const until = now() + 3000
    let r
    while (now() < until) {
      r = await this.daemon.find(this.ptyId, { record: false })
      const tail = r.terminal?.output_tail
      if (tail === last && tail >= (ready.oracle_len ?? 0)) {
        if (++stable >= 2) break
      } else stable = 0
      last = tail
      await sleep(50)
    }
    this.origin = r?.terminal?.output_tail ?? null
    this.originHead = r?.terminal?.output_head ?? null
    this.ctx.trace.add("origin", {
      fx: this.name,
      origin: this.origin,
      head: this.originHead,
      preLen_oracle: this.preLen,
      origin_equals_preLen: this.origin === this.preLen,
      lifecycle: r?.terminal?.lifecycle,
      mode: mode && { echo_off: mode.echo_off, opost_off: mode.opost_off, columns: mode.columns, rows: mode.rows, isTTY: mode.isTTY, env_keys: mode.env_keys, set_status: mode.set_status },
    })
    return this.origin
  }
  // expected native tail after the fixture reported oracle length `oracleLen`
  nativeTailFor(oracleLen) {
    return this.origin + (oracleLen - this.preLen)
  }
  async waitTail(expected, timeoutMs = T.event, subs = []) {
    const until = now() + timeoutMs
    let tail = null
    while (now() < until) {
      const r = await this.daemon.find(this.ptyId, { record: false })
      tail = r.terminal?.output_tail ?? null
      this.lastTerminal = r.terminal
      if (tail !== null && tail >= expected && subs.every((s) => s.maxEnd >= expected)) {
        return { ok: true, tail, terminal: r.terminal }
      }
      await sleep(25)
    }
    return { ok: false, tail, terminal: this.lastTerminal, subs: subs.map((s) => ({ label: s.label, maxEnd: s.maxEnd })) }
  }
  async observeRunning() {
    const r = await this.daemon.find(this.ptyId, { label: `list-running-${this.name}` })
    const running = r.terminal?.lifecycle?.status === "running"
    if (running) {
      this.ctx.order.push({ kind: "native-running", fx: this.name })
      this.ctx.trace.add("native-running", { fx: this.name, terminal: tsum(r.terminal) })
    } else this.ctx.trace.add("native-not-running", { fx: this.name, terminal: tsum(r.terminal) })
    return { running, terminal: r.terminal }
  }
  procExitWatch(timeoutMs = T.event) {
    // independent of native: poll /proc for the identified PTY child
    const id = this.procId
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        const st = procState(id)
        if (!st.startsWith("alive")) return resolve({ state: st, wall_ms: Date.now(), after_ms: Date.now() - t0 })
        if (Date.now() - t0 > timeoutMs) return resolve({ state: st, timedOut: true, wall_ms: Date.now(), after_ms: Date.now() - t0 })
        setTimeout(tick, 10)
      }
      tick()
    })
  }
}

// ---- Sub ----
export class Sub {
  constructor(ctx, daemon, fx, label, { role, attachmentID }) {
    this.ctx = ctx
    this.daemon = daemon
    this.fx = fx
    this.label = label
    this.role = role
    this.attachmentID = attachmentID ?? label
    this.replay = null
    this.live = []
    this.rawIntervals = []
    this.maxEnd = 0
    this.frameCount = 0
    this.liveBytes = 0
    this.events = []
    this.problems = []
    this.exit = null
    this.eof = null
    this.close = null
    this.errors = []
    this.attachResult = null
    this.detachedLocally = false
    this.afterDetach = 0
    this.sampled = 0
    ctx.subs.push(this)
  }
  async attach(cursor, { takeover = false } = {}) {
    const ctx = this.ctx
    ctx.guard(`attach ${this.label}`)
    const d = this.daemon
    this.conn = ctx.newConn(this.label, d)
    this.requestedCursor = cursor
    ctx.trace.add("sub-attach", { sub: this.label, fx: this.fx.name, role: this.role, attachmentID: this.attachmentID, cursor, takeover })
    try {
      await this.conn.open(T.request)
    } catch (e) {
      this.attachResult = { failure: "connect", message: e.message }
      ctx.trace.add("sub-attach-failed", { sub: this.label, ...this.attachResult })
      return this
    }
    this.conn.write(d.reg.token, { op: "subscribe", id: this.fx.ptyId, offset: cursor, attachment_id: this.attachmentID, role: this.role, takeover })
    const item = await this.conn.next(T.request)
    if (item.kind !== "frame") {
      this.attachResult = { failure: item.kind, length: item.length, message: item.message }
      ctx.trace.add("sub-attach-failed", { sub: this.label, ...this.attachResult })
      return this
    }
    const c = classifyFrame(item.buf)
    if (c.type !== "json" || c.json.type !== "attached") {
      this.attachResult = { unexpected: c.json ? compactResp(c.json) : c.type, problems: c.problems }
      ctx.trace.add("sub-attach-response", { sub: this.label, ...this.attachResult })
      this.conn.setHandler((it) => this.onItem(it))
      return this
    }
    const a = c.json
    this.attached = a
    const data = Buffer.from(a.replay_base64, "base64")
    // replay start is not stated on the wire; infer only when length is consistent with exactly one bound.
    let start = null
    let basis = "unverified"
    if (data.length === a.end_offset - a.requested_offset && a.requested_offset >= a.available_offset) (start = a.requested_offset), (basis = "requested_offset")
    else if (data.length === a.end_offset - a.available_offset) (start = a.available_offset), (basis = "available_offset")
    this.replay = { start, end: a.end_offset, data, basis, length: data.length }
    if (start !== null) this.maxEnd = Math.max(this.maxEnd, a.end_offset)
    else this.maxEnd = Math.max(this.maxEnd, a.end_offset)
    this.attachResult = {
      type: "attached",
      role: a.role,
      generation: a.generation,
      requested_offset: a.requested_offset,
      available_offset: a.available_offset,
      end_offset: a.end_offset,
      truncated: a.truncated,
      replay_len: data.length,
      replay_start_basis: basis,
      replay_start: start,
      terminal: tsum(a.terminal),
      problems: c.problems,
      bind: { instance_id: d.instance_id, pty_id: a.terminal.id, group_id: a.terminal.group_id, socket: this.label },
    }
    ctx.trace.add("sub-attached", { sub: this.label, ...this.attachResult })
    this.conn.setHandler((it) => this.onItem(it))
    return this
  }
  onItem(it) {
    const ctx = this.ctx
    if (this.detachedLocally && it.kind === "frame") this.afterDetach++
    if (it.kind === "frame") {
      const c = classifyFrame(it.buf)
      if (c.problems?.length) this.problems.push({ t: it.t, type: c.type, problems: c.problems })
      if (c.type === "output") {
        this.frameCount++
        this.liveBytes += c.len
        this.maxEnd = Math.max(this.maxEnd, c.end)
        this.live.push({ start: c.start, end: c.end, data: c.data, t: it.t })
        if (this.rawIntervals.length < 60000) this.rawIntervals.push([c.start, c.end])
        if (this.sampled++ < 40) ctx.trace.add("output", { sub: this.label, start: c.start, end: c.end, len: c.len })
        return
      }
      if (c.type === "json") {
        const j = c.json
        this.events.push({ t: it.t, ...compactResp(j) })
        if (j.type === "exited") this.exit = { exit_code_raw: j.exit_code, final_offset: j.final_offset, t: it.t, wall: Date.now() }
        ctx.trace.add("sub-event", { sub: this.label, event: compactResp(j) })
        return
      }
      ctx.trace.add("sub-bad-frame", { sub: this.label, type: c.type, problems: c.problems })
      return
    }
    if (it.kind === "eof") this.eof = { t: it.t, wall: Date.now(), afterExit: !!this.exit }
    else if (it.kind === "close") this.close = { t: it.t, wall: Date.now(), hadError: it.hadError, local: it.local }
    else this.errors.push({ kind: it.kind, ...it, t: it.t })
    ctx.trace.add("sub-conn", { sub: this.label, conn_event: it.kind, hadError: it.hadError, local: it.local, message: it.message, length: it.length })
  }
  intervals() {
    const out = []
    if (this.replay && this.replay.start !== null && this.replay.length > 0) out.push({ start: this.replay.start, end: this.replay.start + this.replay.length, data: this.replay.data, from: "replay" })
    for (const l of this.live) out.push({ start: l.start, end: l.end, data: l.data, from: "live" })
    return out
  }
  detach() {
    this.ctx.trace.add("sub-detach", { sub: this.label })
    this.ctx.order.push({ kind: "sub-detach", sub: this.label })
    this.detachedLocally = true
    try {
      this.conn.destroy()
    } catch (e) {
      this.ctx.trace.add("sub-detach-error", { sub: this.label, message: e.message })
    }
  }
  async waitFor(pred, ms = T.event) {
    const until = now() + ms
    while (now() < until) {
      if (pred()) return true
      await sleep(10)
    }
    return pred()
  }
  summary() {
    return {
      label: this.label,
      role_requested: this.role,
      attachmentID: this.attachmentID,
      requestedCursor: this.requestedCursor,
      attach: this.attachResult,
      frames: this.frameCount,
      liveBytes: this.liveBytes,
      maxEnd: this.maxEnd,
      exit: this.exit,
      eof: this.eof,
      close: this.close,
      errors: this.errors,
      problems: this.problems.slice(0, 20),
      events: this.events.slice(0, 40),
      rawIntervalsCount: this.rawIntervals.length,
      rawIntervals: this.rawIntervals.length <= 400 ? this.rawIntervals : { first: this.rawIntervals.slice(0, 100), last: this.rawIntervals.slice(-100), total: this.rawIntervals.length },
      detachedLocally: this.detachedLocally,
      framesAfterLocalDetach: this.afterDetach,
    }
  }
}
