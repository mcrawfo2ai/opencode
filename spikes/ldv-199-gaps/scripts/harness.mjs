// LDV-199 gaps harness: Daemon (identity-fenced), Fixture (gate/ack/frozen oracle), Sub (lossless stream capture). Throwaway.
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { Conn, classifyFrame } from "./wire.mjs"
import { now, wallMs, sha256, sleep, W, registerSecret, scrub, procIdentity, sameIdentity, procState, isAlive, bootID, inventoryDir } from "./lib.mjs"

export const ROOT = "/tmp/g" // inside the private /tmp bind (workspace-scratch backed)
export const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname)

export class Ctx {
  constructor(ev, trace, exe, exeSha) {
    Object.assign(this, { ev, trace, exe, exeSha })
    this.daemons = []
    this.fixtures = []
    this.subs = []
    this.conns = new Set()
    this.seq = 0
    this.softDeadline = null // set on first daemon launch (+14 min)
    this.firstLaunch = null
    this.caseName = "run"
    this.notes = []
  }
  setCase(name) {
    this.caseName = name
    this.trace.caseName = name
  }
  guard(label) {
    if (this.softDeadline !== null && now() > this.softDeadline) throw new Error(`overall-budget: no new actions after 14 min (${label})`)
  }
  newConn(label, daemon, rxRel) {
    const c = new Conn({ label, socketPath: daemon.reg.socket, ev: this.ev, caseName: this.caseName, rxRel })
    this.conns.add(c)
    return c
  }
}

export const tsum = (t) => t && { id: t.id, pid: t.pid, fg: t.foreground_process, group: t.group_id, lifecycle: t.lifecycle, head: t.output_head, tail: t.output_tail, cols: t.cols, rows: t.rows }

// ---------------------------------------------------------------- Daemon
export class Daemon {
  constructor(G, tag, runtimeDir) {
    Object.assign(this, { G, tag, runtimeDir })
    this.exitInfo = null
    this.owner = null
    this.n = 0
  }
  inspectRegistration() {
    // contents stay in memory; only presence/metadata are ever recorded
    const f = path.join(this.runtimeDir, "service.json")
    let text
    try {
      text = fs.readFileSync(f, "utf8")
    } catch (e) {
      return { state: "missing", code: e.code }
    }
    try {
      const reg = JSON.parse(text)
      if (typeof reg.token === "string") registerSecret(reg.token)
      if (typeof reg.socket !== "string" || typeof reg.pid !== "number" || typeof reg.instance_id !== "string") return { state: "unexpected-shape", keys: Object.keys(reg).sort() }
      return { state: "ok", reg }
    } catch (e) {
      return { state: "unparsable" }
    }
  }
  async launch() {
    const G = this.G
    G.guard(`launch ${this.tag}`)
    // rehash the exact executable immediately before launch
    const bytes = fs.readFileSync(G.exe)
    const st = fs.lstatSync(G.exe)
    const rehash = { path: G.exe, bytes: bytes.length, sha256: sha256(bytes), mode: (st.mode & 0o7777).toString(8), symlink: st.isSymbolicLink() }
    G.trace.add("exe-rehash", { daemon: this.tag, ...rehash, matches_pin: rehash.sha256 === G.exeSha })
    if (rehash.sha256 !== G.exeSha || st.isSymbolicLink()) throw new Error("executable identity mismatch before launch")
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 })
    const home = path.join(ROOT, "home")
    this.env = {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      XDG_CONFIG_HOME: path.join(home, "xdg/config"),
      XDG_DATA_HOME: path.join(home, "xdg/data"),
      XDG_CACHE_HOME: path.join(home, "xdg/cache"),
      XDG_RUNTIME_DIR: path.join(home, "xdg/runtime"),
      OPENCODE_PTY_RUNTIME_DIR: this.runtimeDir,
    }
    for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) fs.mkdirSync(this.env[k], { recursive: true, mode: 0o700 })
    this.inventoryBefore = inventoryDir(this.runtimeDir)
    G.trace.add("daemon-launch-requested", { daemon: this.tag, runtime_dir: this.runtimeDir, inventory_before: this.inventoryBefore })
    const t0 = now()
    const child = spawn(G.exe, ["daemon"], { detached: true, stdio: "ignore", env: this.env })
    await new Promise((res, rej) => (child.once("spawn", res), child.once("error", rej)))
    child.unref()
    this.child = child
    child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal, t_ms: Math.round(now() * 1000) / 1000, wall_ms: wallMs() }
      G.trace.add("daemon-exit-event", { daemon: this.tag, pid: child.pid, ...this.exitInfo })
    })
    this.procId = procIdentity(child.pid)
    G.daemons.push(this)
    if (G.firstLaunch === null) {
      G.firstLaunch = now()
      G.softDeadline = G.firstLaunch + 14 * 60 * 1000
      G.trace.firstLaunchMs = G.firstLaunch
      G.trace.add("first-daemon-launch", { daemon: this.tag, hard_deadline_ms_from_launch: 15 * 60 * 1000, soft_stop_ms_from_launch: 14 * 60 * 1000 })
    }
    this.polls = []
    let lastState = null
    let ready = false
    const until = now() + W.ready
    while (now() < until && !ready) {
      const insp = this.inspectRegistration()
      let state = insp.state
      let detail = {}
      if (insp.state === "ok") {
        this.reg = insp.reg
        detail = { reg_pid: insp.reg.pid, reg_instance: insp.reg.instance_id, reg_protocol: insp.reg.protocol }
        if (insp.reg.pid !== child.pid) state = "stale-or-foreign-pid"
        else if (insp.reg.protocol !== 7) state = "protocol-mismatch"
        else {
          const ping = await this.oneShot({ op: "ping" }, { label: `ping-launch-${this.tag}`, timeout: 1500 })
          if (ping.failure) (state = `ping-failed:${ping.failure}`), (detail.code = ping.code)
          else if (ping.resp?.type !== "pong" || ping.resp.instance_id !== insp.reg.instance_id || ping.resp.pid !== insp.reg.pid || ping.resp.protocol !== 7) state = "ping-mismatch"
          else {
            ready = true
            this.pingRaw = ping.rawPayload
            this.pingRx = ping.rx
          }
        }
      }
      if (state !== lastState || ready) {
        this.polls.push({ t_ms: Math.round(now() - t0), state, ...detail })
        G.trace.add("launch-poll", { daemon: this.tag, state: ready ? "ready" : state, ...detail })
        lastState = state
      }
      if (!ready) await sleep(50)
    }
    this.readyMs = Math.round(now() - t0)
    this.identity = {
      tag: this.tag,
      spawned_pid: child.pid,
      proc: this.procId,
      runtime_dir: this.runtimeDir,
      env_supplied: this.env, // allowlisted, nonsecret values
      registration_state_final: lastState,
      registration: ready ? { instance_id: this.reg.instance_id, pid: this.reg.pid, protocol: this.reg.protocol, socket: this.reg.socket, keys: Object.keys(this.reg).sort(), token: "<memory-only>" } : null,
      registration_pid_equals_spawned_pid: ready ? this.reg.pid === child.pid : false,
      ping_raw_payload: this.pingRaw ?? null,
      ready,
      ready_ms: this.readyMs,
      readiness_polls: this.polls,
      inventory_before: this.inventoryBefore,
      inventory_after_ready: inventoryDir(this.runtimeDir),
    }
    G.trace.add("daemon-launched", { daemon: this.tag, identity: this.identity })
    if (!ready) return this
    this.instance_id = this.reg.instance_id
    this.owner = await this.openOwner()
    return this
  }
  verifyIdentity(why) {
    const cur = procIdentity(this.procId.pid)
    const ok = sameIdentity(this.procId, cur) && cur.exe === this.procId.exe && cur.state !== "Z"
    this.G.trace.add("identity-check", { daemon: this.tag, why, ok, recorded: { pid: this.procId.pid, starttime_ticks: this.procId.starttime_ticks, boot_id: this.procId.boot_id }, current: cur && { pid: cur.pid, starttime_ticks: cur.starttime_ticks, boot_id: cur.boot_id, state: cur.state } })
    return ok
  }
  rxRel(label) {
    return `cases/${this.G.caseName}/requests/${String(++this.G.seq).padStart(4, "0")}-${label}.rx.bin`
  }
  async openOwner() {
    const G = this.G
    const label = `owner-${this.tag}-${++this.n}`
    const conn = G.newConn(label, this, this.rxRel(label))
    await conn.open(W.request)
    const req = { op: "own", instance_id: this.reg.instance_id }
    G.trace.add("request", { conn: label, op: "own", request: req })
    conn.write(this.reg.token, req)
    const item = await conn.next(W.request)
    const c = item.kind === "frame" ? classifyFrame(item.buf) : null
    G.trace.add("response", { conn: label, response: c?.json ?? { failure: item.kind }, problems: c?.problems, rx: conn.rx.path })
    conn.setHandler((it) => G.trace.add("owner-item", { conn: label, conn_event: it.kind, hadError: it.hadError, local: it.local, message: it.message }))
    if (c?.json?.type !== "owned") throw new Error(`own failed: ${JSON.stringify(c?.json ?? item.kind)}`)
    return { conn, resp: c.json }
  }
  // One request on its own connection. store:false => polling sample (raw payload kept in samples file by caller).
  async oneShot(request, { label, store = true, timeout = W.request } = {}) {
    const G = this.G
    G.guard(`request ${request.op}`)
    const lab = label ?? `req-${this.tag}-${++this.n}`
    const rxRel = store ? this.rxRel(lab) : null
    const conn = G.newConn(lab, this, rxRel)
    const out = { conn: lab, op: request.op, rx: rxRel }
    const t0 = now()
    try {
      await conn.open(timeout)
    } catch (e) {
      Object.assign(out, { failure: "connect", message: e.message, code: e.code })
      if (store) G.trace.add("request-failed", { conn: lab, op: request.op, failure: "connect", code: e.code, message: e.message })
      return out
    }
    if (store) G.trace.add("request", { conn: lab, op: request.op, request })
    conn.write(this.reg.token, request)
    const item = await conn.next(timeout)
    out.rtt_ms = Math.round((now() - t0) * 100) / 100
    if (item.kind === "frame") {
      const c = classifyFrame(item.buf)
      out.resp = c.json
      out.problems = c.problems
      out.frameType = c.type
      out.rawPayload = item.buf.toString("utf8")
    } else {
      out.failure = item.kind
      out.detail = { hadError: item.hadError, message: item.message, declared: item.declared }
    }
    conn.destroy("request-done")
    if (store) G.trace.add("response", { conn: lab, rtt_ms: out.rtt_ms, response_type: out.resp?.type, failure: out.failure, detail: out.detail, problems: out.problems?.length ? out.problems : undefined, rx: rxRel })
    return out
  }
  // list sample: raw native payload appended to samples/<name>.jsonl (lossless payload text), no per-sample trace spam
  async sample(name, { label = "sample" } = {}) {
    const G = this.G
    const r = await this.oneShot({ op: "list" }, { label: `${label}`, store: false })
    G.ev.appendLine(G.caseName, `cases/${G.caseName}/samples/${name}.jsonl`, { seq: G.trace.seq, t_ms: Math.round(now() * 1000) / 1000, wall_ms: wallMs(), op: "list", failure: r.failure ?? null, code: r.code ?? null, raw_payload: r.rawPayload ?? null })
    r.terminals = r.resp?.type === "terminals" ? r.resp.terminals : null
    return r
  }
  async sampleFind(name, ptyId, opts) {
    const r = await this.sample(name, opts)
    r.terminal = r.terminals?.find((t) => t.id === ptyId) ?? null
    return r
  }
}

// ---------------------------------------------------------------- Fixture
export class Fixture {
  constructor(G, daemon, name, { plan, payloads, code = 0 }) {
    Object.assign(this, { G, daemon, name, code })
    this.caseName = G.caseName
    this.dir = path.join(ROOT, "fx", `${G.caseName}-${name}`)
    fs.rmSync(this.dir, { recursive: true, force: true })
    for (const d of ["gates", "acks", "payload"]) fs.mkdirSync(path.join(this.dir, d), { recursive: true })
    this.oraclePath = path.join(this.dir, "oracle.bin")
    fs.writeFileSync(this.oraclePath, "")
    this.group = `ldv199gaps-${G.caseName}-${name}-${process.pid}`
    this.plan = plan
    fs.writeFileSync(path.join(this.dir, "plan.txt"), plan.join("\n") + "\n")
    this.payloadIndex = []
    for (const [fname, buf] of Object.entries(payloads)) {
      const p = path.join(this.dir, "payload", fname)
      fs.writeFileSync(p, buf, { mode: 0o444 })
      fs.chmodSync(p, 0o444)
      this.payloadIndex.push({ name: fname, bytes: buf.length, sha256: sha256(buf), mode: "444" })
    }
    this.gateLog = []
    this.boundaries = []
    this.midAcked = false
    this.runningAfterMid = false
    G.fixtures.push(this)
  }
  async create() {
    const G = this.G
    this.env = { PATH: "/usr/bin:/bin", HOME: path.join(ROOT, "home"), LANG: "C.UTF-8", TMPDIR: "/tmp", TERM: "xterm", COLORTERM: "truecolor", SHELL: "/bin/bash" }
    const req = { op: "create", program: "/bin/bash", args: [path.join(SCRIPT_DIR, "fixture.sh"), this.dir], cwd: this.dir, title: `ldv199gaps-${this.name}`, group_id: this.group, env: this.env, cols: 80, rows: 24 }
    const r = await this.daemon.oneShot(req, { label: `create-${this.name}` })
    if (r.resp?.type !== "created") throw new Error(`create failed: ${JSON.stringify(r.resp ?? r.failure)}`)
    this.terminal = r.resp.terminal
    this.ptyId = r.resp.terminal.id
    this.pid = r.resp.terminal.pid
    this.procId = procIdentity(this.pid)
    this.instance_id = this.daemon.instance_id
    this.createRx = r.rx
    G.trace.add("fixture-created", { fx: this.name, pty_id: this.ptyId, pid: this.pid, group: this.group, instance_id: this.instance_id, proc: this.procId, supplied_env: this.env, create_rx: r.rx })
    return this
  }
  release(gate) {
    fs.writeFileSync(path.join(this.dir, "gates", gate), "")
    const rec = { gate, wall_ms: wallMs(), t_ms: now() }
    this.gateLog.push(rec)
    this.G.trace.add("gate-release", { fx: this.name, gate, wall_ms: rec.wall_ms })
  }
  releaseAll() {
    const names = new Set(this.plan.filter((l) => l.startsWith("gate ")).map((l) => l.split(" ")[1]))
    for (const g of names) {
      const f = path.join(this.dir, "gates", g)
      if (!fs.existsSync(f)) {
        try {
          fs.writeFileSync(f, "")
          this.gateLog.push({ gate: g, wall_ms: wallMs(), t_ms: now(), cleanup: true })
          this.G.trace.add("gate-release", { fx: this.name, gate: g, cleanup: true })
        } catch {}
      }
    }
  }
  readAck(stage) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "acks", `${stage}.json`), "utf8"))
    } catch {
      return null
    }
  }
  async waitAck(stage, ms = W.ack) {
    const until = now() + ms
    while (now() < until) {
      const a = this.readAck(stage)
      if (a) {
        this.G.trace.add("ack-observed", { fx: this.name, stage, ack: a })
        return a
      }
      await sleep(10)
    }
    this.G.trace.add("ack-timeout", { fx: this.name, stage, deadline_ms: ms })
    return null
  }
  freeze(boundary) {
    const len = fs.statSync(this.oraclePath).size
    const f = path.join(this.dir, `oracle.${boundary}.bin`)
    fs.copyFileSync(this.oraclePath, f)
    fs.chmodSync(f, 0o444)
    const buf = fs.readFileSync(f)
    const rec = { boundary, length: buf.length, sha256: sha256(buf), t_ms: Math.round(now() * 1000) / 1000, trace_seq: this.G.trace.seq, matches_live_length: buf.length === len }
    this.boundaries.push(rec)
    this.G.trace.add("oracle-frozen", { fx: this.name, ...rec })
    return rec
  }
  async captureOrigin() {
    const G = this.G
    const ready = await this.waitAck("ready", W.ready)
    if (!ready) throw new Error("fixture ready ack timeout")
    this.modeSize = (() => { try { return fs.readFileSync(path.join(this.dir, "mode.size.txt"), "utf8").trim() } catch { return null } })()
    let last = null
    let stable = 0
    let sample = null
    const until = now() + W.ready
    while (now() < until) {
      const r = await this.daemon.sampleFind(`origin-${this.name}`, this.ptyId, { label: `origin-${this.name}` })
      sample = r.terminal
      const key = sample ? `${sample.output_head}/${sample.output_tail}` : null
      if (key !== null && key === last) stable++
      else stable = 0
      last = key
      if (stable >= 2) break
      await sleep(100)
    }
    this.origin = sample?.output_tail ?? null
    this.originHead = sample?.output_head ?? null
    const rec = { fx: this.name, origin: this.origin, head: this.originHead, head_equals_tail: this.originHead === this.origin, lifecycle: sample?.lifecycle, mode_size: this.modeSize, oracle_len_at_hold: fs.statSync(this.oraclePath).size, stable_samples: stable }
    G.trace.add("origin", rec)
    this.originRec = rec
    return this.origin
  }
  expectedTail(oracleLen) {
    return this.origin + oracleLen
  }
  async running(why) {
    const r = await this.daemon.sampleFind(`running-${this.name}`, this.ptyId, { label: `running-${this.name}` })
    const run = r.terminal?.lifecycle?.status === "running"
    this.G.trace.add(run ? "native-running" : "native-not-running", { fx: this.name, why, terminal: tsum(r.terminal), failure: r.failure, code: r.code })
    return { running: run, terminal: r.terminal, failure: r.failure }
  }
  procExitWatch(ms = W.event) {
    const rec = this.procId
    return new Promise((resolve) => {
      const t0 = now()
      const tick = () => {
        const st = procState(rec)
        if (!st.startsWith("alive")) return resolve({ state: st, after_ms: Math.round(now() - t0), wall_ms: wallMs() })
        if (now() - t0 > ms) return resolve({ state: st, timedOut: true, after_ms: Math.round(now() - t0), wall_ms: wallMs() })
        setTimeout(tick, 10)
      }
      tick()
    })
  }
  // copy fixture-side artifacts + frozen oracle into evidence (bytes stored once)
  finalize() {
    const G = this.G
    const base = `cases/${this.caseName}/fx-${this.name}`
    const ev = G.ev
    const put = (file, rel) => {
      try {
        ev.writeBuf(this.caseName, `${base}/${rel}`, fs.readFileSync(path.join(this.dir, file)))
      } catch {}
    }
    const last = this.boundaries.at(-1)
    const cur = fs.statSync(this.oraclePath).size
    if (!last || last.length !== cur) this.freeze("final")
    const frozen = this.boundaries.at(-1)
    ev.writeBuf(this.caseName, `${base}/oracle.frozen.bin`, fs.readFileSync(path.join(this.dir, `oracle.${frozen.boundary}.bin`)))
    for (const f of ["plan.txt", "stage.log", "mode.saved", "mode.before.txt", "mode.after.txt", "mode.size.txt", "env-names.txt", "signals.log"]) put(f, f)
    try {
      for (const a of fs.readdirSync(path.join(this.dir, "acks"))) if (a.endsWith(".json")) put(`acks/${a}`, `acks/${a}`)
    } catch {}
    ev.writeJson(this.caseName, `${base}/payload-index.json`, this.payloadIndex)
    ev.writeJson(this.caseName, `${base}/oracle.boundaries.json`, this.boundaries)
    ev.writeJson(this.caseName, `${base}/gate-log.json`, this.gateLog)
    // small marker payloads are stored; large chunk payloads are represented by the oracle itself + hashes above
    for (const p of this.payloadIndex) if (p.bytes <= 64) put(`payload/${p.name}`, `payload/${p.name}`)
    return { base, frozen }
  }
  descriptor() {
    let observed = null
    try {
      observed = fs.readFileSync(path.join(this.dir, "env-names.txt"), "utf8").split("\n").filter(Boolean)
    } catch {}
    const supplied = Object.keys(this.env ?? {})
    return {
      child_env_names: { supplied_by_request: supplied.sort(), observed_in_child: observed, not_supplied_by_request: observed ? observed.filter((n) => !supplied.includes(n)) : null, note: "names only; values never dumped. Extra names come from the daemon env merge or the shell (PWD, SHLVL)" },
      name: this.name,
      dir_rel: `fx-${this.name}`,
      pty_id: this.ptyId,
      group_id: this.group,
      instance_id: this.instance_id,
      pid: this.pid,
      proc: this.procId,
      origin: this.origin,
      origin_head: this.originHead,
      origin_sample_file: `samples/origin-${this.name}.jsonl`,
      create_rx: this.createRx,
      oracle: "oracle.frozen.bin",
      boundaries: this.boundaries,
      plan: this.plan,
    }
  }
}

// ---------------------------------------------------------------- Sub (stream subscriber with lossless capture)
export class Sub {
  constructor(G, daemon, fx, label, { role, attachmentID }) {
    Object.assign(this, { G, daemon, fx, label, role })
    this.attachmentID = attachmentID ?? label
    this.caseName = G.caseName
    this.live = []
    this.maxEnd = 0
    this.frameCount = 0
    this.events = []
    this.problems = []
    this.exit = null
    this.eof = null
    this.close = null
    this.errors = []
    this.attachResult = null
    this.replayFile = null
    this.detachedLocally = false
    this.framesAfterDetach = 0
    this.idxRel = `cases/${this.caseName}/captures/${label}.index.jsonl`
    this.rxRel = `cases/${this.caseName}/captures/${label}.rx.bin`
    this.finalized = false
    G.subs.push(this)
  }
  async attach(cursor, { takeover = false } = {}) {
    const G = this.G
    G.guard(`attach ${this.label}`)
    this.requestedCursor = cursor
    this.takeover = takeover
    this.conn = G.newConn(this.label, this.daemon, this.rxRel)
    G.trace.add("sub-attach", { sub: this.label, fx: this.fx.name, role: this.role, attachment_id: this.attachmentID, cursor, takeover })
    try {
      await this.conn.open(W.request)
    } catch (e) {
      this.attachResult = { failure: "connect", message: e.message, code: e.code }
      G.trace.add("sub-attach-failed", { sub: this.label, ...this.attachResult })
      return this
    }
    this.conn.write(this.daemon.reg.token, { op: "subscribe", id: this.fx.ptyId, offset: cursor, attachment_id: this.attachmentID, role: this.role, takeover })
    const item = await this.conn.next(W.request)
    if (item.kind !== "frame") {
      this.attachResult = { failure: item.kind, declared: item.declared, message: item.message, t_ms: Math.round(item.t * 1000) / 1000 }
      // the terminal item consumed as the attach outcome is still recorded as its own fact (EOF is not an exited frame)
      if (item.kind === "eof") this.eof = { t_ms: item.t, wall_ms: wallMs(), afterExitFrame: false, consumed_as_attach_failure: true }
      else if (item.kind !== "timeout") this.errors.push({ kind: item.kind, t_ms: item.t, message: item.message, declared: item.declared })
      this.indexLine({ i: this.frameCount++, kind: `conn:${item.kind}`, t_ms: Math.round(item.t * 1000) / 1000, declared: item.declared, message: item.message })
      G.trace.add("sub-attach-failed", { sub: this.label, ...this.attachResult })
      this.conn.setHandler((it) => this.onItem(it))
      return this
    }
    const c = classifyFrame(item.buf)
    this.indexLine({ i: this.frameCount++, t_ms: item.t, hdrOff: item.hdrOff, payload_len: item.len, kind: c.type === "json" ? c.json.type : c.type })
    if (c.type !== "json" || c.json.type !== "attached") {
      this.attachResult = { unexpected: c.json ?? c.type, problems: c.problems }
      G.trace.add("sub-attach-response", { sub: this.label, ...this.attachResult })
      this.conn.setHandler((it) => this.onItem(it))
      return this
    }
    const a = c.json
    this.attached = a
    const data = Buffer.from(a.replay_base64, "base64")
    let start = null
    let basis = "unverified"
    if (data.length === a.end_offset - a.requested_offset && a.requested_offset >= a.available_offset) (start = a.requested_offset), (basis = "requested_offset")
    else if (data.length === a.end_offset - a.available_offset) (start = a.available_offset), (basis = "available_offset")
    if (data.length > 0) {
      const rel = `cases/${this.caseName}/captures/${this.label}.replay.bin`
      const w = G.ev.writeBuf(this.caseName, rel, data)
      this.replayFile = w ? { path: rel, bytes: w.bytes, sha256: w.sha256 } : { lost: true }
    }
    this.maxEnd = Math.max(this.maxEnd, a.end_offset)
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
      replay_file: this.replayFile,
      terminal: tsum(a.terminal),
      problems: c.problems,
    }
    G.trace.add("sub-attached", { sub: this.label, ...this.attachResult })
    this.conn.setHandler((it) => this.onItem(it))
    return this
  }
  indexLine(rec) {
    this.G.ev.appendLine(this.caseName, this.idxRel, rec)
  }
  onItem(it) {
    const G = this.G
    if (this.detachedLocally && it.kind === "frame") this.framesAfterDetach++
    if (it.kind === "frame") {
      const c = classifyFrame(it.buf)
      const rec = { i: this.frameCount++, t_ms: Math.round(it.t * 1000) / 1000, hdrOff: it.hdrOff, payload_len: it.len, kind: c.type === "json" ? c.json.type : c.type }
      if (c.type === "output") {
        Object.assign(rec, { start: c.start, end: c.end })
        this.live.push({ start: c.start, end: c.end, hdrOff: it.hdrOff })
        this.maxEnd = Math.max(this.maxEnd, c.end)
      }
      if (c.problems?.length) {
        rec.problems = c.problems
        this.problems.push({ i: rec.i, problems: c.problems })
      }
      this.indexLine(rec)
      if (c.type === "json") {
        const j = c.json
        this.events.push({ t_ms: it.t, type: j.type, ...(j.type === "controller_changed" ? { attachment_id: j.attachment_id, generation: j.generation } : {}) })
        if (j.type === "exited") {
          this.exit = { exit_code_raw: j.exit_code, exit_code_key_present: Object.hasOwn(j, "exit_code"), final_offset: j.final_offset, raw_payload: c.text, t_ms: it.t, wall_ms: wallMs(), hdrOff: it.hdrOff }
          G.trace.add("sub-exited-frame", { sub: this.label, exit: this.exit })
        } else if (j.type !== "attached") G.trace.add("sub-event", { sub: this.label, event: j })
      }
      return
    }
    const rec = { kind: it.kind, t_ms: Math.round(it.t * 1000) / 1000, hdrOff: it.hdrOff, hadError: it.hadError, local: it.local, message: it.message, declared: it.declared, pending: it.pending, reason: it.reason }
    if (it.kind === "eof") this.eof = { t_ms: it.t, wall_ms: wallMs(), afterExitFrame: !!this.exit }
    else if (it.kind === "close") this.close = { t_ms: it.t, wall_ms: wallMs(), hadError: it.hadError, local: it.local, reason: it.reason }
    else this.errors.push(rec)
    this.indexLine({ i: this.frameCount++, ...rec, kind: `conn:${it.kind}` })
    G.trace.add("sub-conn", { sub: this.label, conn_event: it.kind, hadError: it.hadError, local: it.local, message: it.message, declared: it.declared, pending: it.pending, after_exit_frame: !!this.exit })
  }
  detach(reason) {
    this.G.trace.add("sub-detach", { sub: this.label, reason })
    this.detachedLocally = true
    this.detachReason = reason
    this.detachWall = wallMs()
    try {
      this.conn?.destroy(reason)
    } catch (e) {
      this.G.trace.add("sub-detach-error", { sub: this.label, message: e.message })
    }
  }
  async waitFor(pred, ms) {
    const until = now() + ms
    while (now() < until) {
      if (pred()) return true
      await sleep(10)
    }
    return pred()
  }
  finalize() {
    if (this.finalized) return
    this.finalized = true
    const meta = {
      label: this.label,
      case: this.caseName,
      fx: this.fx.name,
      role_requested: this.role,
      attachment_id: this.attachmentID,
      requested_cursor: this.requestedCursor,
      takeover: this.takeover,
      expected_identity: { instance_id: this.daemon.instance_id, pty_id: this.fx.ptyId, group_id: this.fx.group },
      daemon: this.daemon.tag,
      attach: this.attachResult,
      rx: { path: this.rxRel, bytes_written: this.conn?.rx.bytes ?? 0, lost: this.conn?.rx.lost ?? false, lost_reason: this.conn?.rx.lostReason ?? null, bytes_in: this.conn?.bytesIn ?? 0 },
      index_file: this.idxRel,
      frames: this.frameCount,
      max_end_online: this.maxEnd,
      exited_frame_client_view: this.exit,
      eof: this.eof,
      close: this.close,
      errors: this.errors,
      problems: this.problems.slice(0, 20),
      detached_locally: this.detachedLocally,
      detach_reason: this.detachReason ?? null,
      frames_after_local_detach: this.framesAfterDetach,
      client_views_note: "all *_client_view / *_online fields are client-derived; offline/verify.py re-derives from rx.bin",
    }
    this.G.ev.writeJson(this.caseName, `cases/${this.caseName}/captures/${this.label}.meta.json`, meta)
    return meta
  }
}
