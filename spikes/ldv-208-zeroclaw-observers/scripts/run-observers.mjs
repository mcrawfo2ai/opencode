// Throwaway driver for the ldv-208 observers spike. Run with bun.
//   RUN_DIR=<private dir> EVID_DIR=<evidence dir> ZC_BIN=<zeroclaw> bun run-observers.mjs main|approval
// Flow control is driven by the stub's own log (gates), never by a socket, so a dropped socket cannot stall the run.
// Raw WS frames are appended to one file per socket BEFORE any parsing.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { Evidence, mono, procIdentity, freePort, spawnOwned, waitFor, cleanup } from "./harness.mjs"

const MODE = process.argv[2] ?? "main"
const APPROVAL = MODE.includes("approval")
const RUN = process.env.RUN_DIR, EVD = path.join(process.env.EVID_DIR, MODE), BIN = process.env.ZC_BIN
for (const d of ["home", "config", "workspace", "logs", "data"]) fs.mkdirSync(path.join(RUN, d), { recursive: true })
fs.mkdirSync(EVD, { recursive: true })
const ev = new Evidence(EVD)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 50) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step) } return false }

// ---- fixture, stub, gateway ----
const FIXTURE = path.join(RUN, "workspace", "fixture.txt")
fs.writeFileSync(FIXTURE, "ldv208-obs-fixture-" + crypto.randomBytes(6).toString("hex") + "\n")
const gwPort = await freePort()
const stubPortFile = path.join(RUN, "logs", "stub.port"), stubLogFile = path.join(RUN, "logs", "stub-oracle.jsonl"), fixturePtr = path.join(RUN, "logs", "fixture.path")
fs.writeFileSync(fixturePtr, FIXTURE)
const minimalEnv = { PATH: "/usr/bin:/bin", HOME: path.join(RUN, "home"), LANG: "C.UTF-8", NO_PROXY: "*", RUST_BACKTRACE: "0" }
const stub = spawnOwned("stub-provider", "python3", [path.resolve(import.meta.dir, "stub_provider.py"), stubPortFile, fixturePtr, stubLogFile], minimalEnv, path.join(RUN, "logs", "stub.out"))
await waitFor(() => fs.existsSync(stubPortFile) && fs.readFileSync(stubPortFile, "utf8"), 10000, "stub port")
const STUB = `http://127.0.0.1:${Number(fs.readFileSync(stubPortFile, "utf8"))}`
const AUTO = APPROVAL ? ["file_write", "file_edit", "memory_recall", "memory_store", "calculator", "glob_search", "content_search"] : ["file_read", "file_write", "file_edit", "memory_recall", "memory_store", "calculator", "glob_search", "content_search"]
const CONFIG = `schema_version = 3

[providers.models.custom.stub]
model = "stub-model"
uri = "${STUB}/v1"

[agents.default]
enabled = true
model_provider = "custom.stub"
risk_profile = "default"
runtime_profile = "default"

[agents.default.workspace]
path = "${path.join(RUN, "workspace")}"

[risk_profiles.default]
level = "supervised"
auto_approve = [${AUTO.map((s) => `"${s}"`).join(", ")}]
${APPROVAL ? 'always_ask = ["file_read"]\n' : ""}
[runtime_profiles.default]
max_tool_iterations = 8
max_tool_result_chars = 50000
max_context_tokens = 32000

[runtime_profiles.default.context_compression]
enabled = false
tool_result_retrim_chars = 2000

[gateway]
port = ${gwPort}
host = "127.0.0.1"
allow_public_bind = false
require_pairing = false
session_persistence = true

[memory]
backend = "sqlite"
auto_save = false
embedding_provider = "none"
`
fs.writeFileSync(path.join(RUN, "config", "config.toml"), CONFIG)
ev.write("config.sanitized.toml", CONFIG.replaceAll(RUN, "<RUN>"))
const gwEnv = { ...minimalEnv, ZEROCLAW_CONFIG_DIR: path.join(RUN, "config"), ZEROCLAW_DATA_DIR: path.join(RUN, "data") }
const gw = spawnOwned("zeroclaw-gateway", BIN, ["gateway", "start", "-p", String(gwPort), "--host", "127.0.0.1"], gwEnv, path.join(RUN, "logs", "gateway.out"))
const NATIVE = `http://127.0.0.1:${gwPort}`
await waitFor(async () => (await fetch(NATIVE + "/health")).ok, 15000, "gateway /health")
const meta = { mode: MODE, gwPort, stubPort: Number(STUB.split(":").pop()), gateway: gw.identity, stub: stub.identity, started_wall: new Date().toISOString() }
ev.write("run-meta.json", meta)

// ---- stub oracle helpers ----
const slog = async () => (await fetch(`${STUB}/control/log`)).json()
const lastSeq = async () => { const l = await slog(); return l.length ? l[l.length - 1].seq : 0 }
const release = async (gate, marker) => (await fetch(`${STUB}/control/release?gate=${gate}&marker=${marker}`, { method: "POST" })).json()
async function gateWait(gate, afterSeq, ms = 8000) { let hit = null; await until(async () => { hit = (await slog()).find((e) => e.kind === "gate_wait" && e.gate === gate && e.seq > afterSeq) ?? null; return !!hit }, ms, 100); return hit }

// ---- sockets: raw frames first, parse second ----
class Sock {
  constructor(sc, name, session) { this.sc = sc; this.name = name; this.session = session; this.frames = []; this.closeInfo = null; this.file = path.join(EVD, `${sc.name}.${name}.raw.jsonl`); this.opened = false }
  raw(kind, data) { fs.appendFileSync(this.file, ev.redact(JSON.stringify({ t_ms: mono(), wall_ms: Date.now(), ev: kind, data })) + "\n") }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/chat?agent=default&session_id=${this.session}`)
    this.ws.addEventListener("open", () => { this.opened = true; this.raw("open", null) })
    this.ws.addEventListener("message", (e) => { const data = typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8"); this.raw("message", data); let obj; try { obj = JSON.parse(data) } catch { obj = { type: "<unparsed>" } } this.frames.push({ t_ms: mono(), obj }) })
    this.ws.addEventListener("close", (e) => { this.closeInfo = { code: e.code, reason: e.reason, wasClean: e.wasClean }; this.raw("close", this.closeInfo) })
    this.ws.addEventListener("error", () => this.raw("error", null))
    await until(() => this.opened || this.closeInfo, 5000)
    await sleep(300) // let any greeting frame arrive
    return this
  }
  send(obj) { const s = JSON.stringify(obj); this.raw("sent", s); this.ws.send(s) }
  async close() { this.ws.close(1000, "spike-close"); await until(() => this.closeInfo, 3000) }
  count(type) { return this.frames.filter((f) => f.obj.type === type).length }
}

const brief = (o) => { const s = JSON.stringify(o); return s.length > 170 ? s.slice(0, 170) + "…" : s }
const safeJson = (t) => { try { return JSON.parse(t) } catch { return t.slice(0, 300) } }
const get = async (p) => { try { const r = await fetch(NATIVE + p, { signal: AbortSignal.timeout(4000) }); return { status: r.status, body: safeJson(await r.text()) } } catch (e) { return { status: null, error: String(e) } } }

function newScenario(name) {
  const sc = { name, session: `${name}-${crypto.randomBytes(3).toString("hex")}`, socks: {}, timeline: [], snaps: [], samples: [], stubSeq0: 0, stopSampler: false }
  sc.mark = (stage, extra = {}) => sc.timeline.push({ t_ms: mono(), stage, ...extra })
  sc.open = async (n) => { const s = new Sock(sc, n, sc.session); sc.socks[n] = s; await s.open(); return s }
  sc.snap = async (label) => { const m = await get(`/api/sessions/${sc.session}/messages`); sc.snaps.push({ label, t_ms: mono(), messages: m }); sc.mark("snapshot", { label }) }
  sc.start = async () => {
    sc.stubSeq0 = await lastSeq()
    sc.sampler = (async () => { while (!sc.stopSampler) { const t_ms = mono(); const [running, state] = await Promise.all([get("/api/sessions/running"), get(`/api/sessions/${sc.session}/state`)]); sc.samples.push({ t_ms, running, state }); await sleep(500) } })()
  }
  sc.finish = async () => {
    sc.stopSampler = true; await sc.sampler
    for (const s of Object.values(sc.socks)) if (s.ws.readyState === 1) await s.close()
    const stubSlice = (await slog()).filter((e) => e.seq > sc.stubSeq0)
    const summary = {
      scenario: sc.name, session: sc.session, timeline: sc.timeline,
      sockets: Object.fromEntries(Object.values(sc.socks).map((s) => [s.name, { close: s.closeInfo, frames: s.frames.map((f, i) => ({ i, t_ms: f.t_ms, type: f.obj.type, brief: brief(f.obj) })) }])),
      snapshots: sc.snaps.map((s) => ({ label: s.label, t_ms: s.t_ms, status: s.messages.status, count: s.messages.body?.messages?.length ?? s.messages.body?.length ?? null, roles_heads: (s.messages.body?.messages ?? s.messages.body ?? []).map?.((m) => `${m.role}: ${String(m.content).replace(/\s+/g, " ").slice(0, 90)}`) })),
      samples_busy_summary: sc.samples.map((x) => ({ t_ms: x.t_ms, running: x.running.body, state: x.state.body, rs: x.running.status, ss: x.state.status })),
      stub_log_slice: stubSlice.map((e) => ({ seq: e.seq, mono_ms: e.mono_ms, kind: e.kind, gate: e.gate, phase: e.phase, delta_keys: e.delta_keys, finish: e.finish })),
    }
    ev.write(`${sc.name}.summary.json`, summary)
    ev.write(`${sc.name}.snapshots.json`, sc.snaps)
    ev.write(`${sc.name}.samples.json`, sc.samples)
    ev.write(`${sc.name}.stub-slice.json`, stubSlice)
    return summary
  }
  return sc
}

// One gated turn. Hooks run at defined stages; stub gates, not sockets, pace it.
async function runTurn(sc, { sender, text, hooks = {}, holds = {} }) {
  const seq0 = await lastSeq()
  sender.send({ type: "message", content: text }); sc.mark("prompt_sent", { on: sender.name })
  const g1 = await gateWait("g1", seq0)
  if (!g1) { sc.mark("g1_not_reached_8s"); return "none" }
  sc.mark("stub_g1_waiting", { marker: g1.marker })
  await sleep(holds.beforeG1 ?? 0); await hooks.beforeG1?.()
  await release("g1", g1.marker); sc.mark("g1_released")
  await sleep(800) // chunk delivery window
  await hooks.afterChunk?.(); await sleep(holds.afterChunk ?? 0)
  await release("g2", g1.marker); sc.mark("g2_released")
  const g3 = await gateWait("g3", seq0, 7000)
  if (!g3) { sc.mark("phase2_request_not_seen_7s"); return "g2" }
  sc.mark("stub_g3_waiting")
  await sleep(holds.beforeG3 ?? 0); await hooks.beforeG3?.()
  await release("g3", g1.marker); sc.mark("g3_released")
  await until(async () => (await slog()).some((e) => e.kind === "emitted" && e.seq > g3.seq && e.finish === "stop"), 4000)
  await sleep(1500); sc.mark("turn_window_end")
  return "done"
}

const results = {}
const prompt = (tag) => `${tag} nonce=${crypto.randomBytes(3).toString("hex")}`
const ALL = {
  async s1a_both_before() { // Q1: A and B attached before the prompt; prompt on A
    const sc = newScenario("s1a_both_before"); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    await sc.snap("pre-prompt")
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q1a read the fixture"), holds: { beforeG1: 1500, afterChunk: 1000, beforeG3: 1000 }, hooks: { afterChunk: () => sc.snap("after-first-chunk"), beforeG3: () => sc.snap("before-final") } })
    await sc.snap("after-done"); return sc.finish()
  },
  async s1b_B_midturn() { // Q1: B attaches after the first chunk
    const sc = newScenario("s1b_B_midturn"); const A = await sc.open("A"); await sc.start()
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q1b read the fixture"), holds: { afterChunk: 500, beforeG3: 1000 }, hooks: { afterChunk: async () => { await sc.open("B"); sc.mark("B_attached_after_first_chunk") }, beforeG3: () => sc.snap("before-final") } })
    await sc.snap("after-done"); return sc.finish()
  },
  async s1c_B_after_done() { // Q1: B attaches after done
    const sc = newScenario("s1c_B_after_done"); const A = await sc.open("A"); await sc.start()
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q1c read the fixture") })
    await sc.snap("after-done-before-B"); await sc.open("B"); sc.mark("B_attached_after_done"); await sleep(2000); await sc.snap("after-B-attached"); return sc.finish()
  },
  async s2_prompt_from_B() { // Q2: turn 1 on A, then A idle, turn 2 on B
    const sc = newScenario("s2_prompt_from_B"); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    results[sc.name + ":turn1(A)"] = await runTurn(sc, { sender: A, text: prompt("Q2 turn ONE from A") })
    await sc.snap("after-turn1"); sc.mark("A_idle_now_prompt_on_B"); const nA = A.frames.length, nB = B.frames.length; sc.mark("frame_counts_before_turn2", { A: nA, B: nB })
    results[sc.name + ":turn2(B)"] = await runTurn(sc, { sender: B, text: prompt("Q2 turn TWO from B") })
    await sc.snap("after-turn2"); return sc.finish()
  },
  async s3a_owner_drop() { // Q3: owner closes mid-turn, no other socket
    const sc = newScenario("s3a_owner_drop"); const A = await sc.open("A"); await sc.start()
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q3a read the fixture"), holds: { afterChunk: 3500 }, hooks: { afterChunk: async () => { await A.close(); sc.mark("A_closed_mid_turn"); await sc.snap("1s-after-drop"); await sleep(1000); await sc.snap("2s-after-drop") }, beforeG3: () => sc.snap("before-final") } })
    await sc.snap("final"); return sc.finish()
  },
  async s3b_owner_drop_B_attached() { // Q3: owner closes mid-turn while B attached
    const sc = newScenario("s3b_owner_drop_B"); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q3b read the fixture"), holds: { afterChunk: 3500 }, hooks: { afterChunk: async () => { await A.close(); sc.mark("A_closed_mid_turn"); await sc.snap("1s-after-drop"); await sleep(1000); await sc.snap("2s-after-drop") }, beforeG3: () => sc.snap("before-final") } })
    await sc.snap("final"); return sc.finish()
  },
  async s4_reconnect() { // Q4: owner drops mid-turn, reopens as A' on the same session
    const sc = newScenario("s4_reconnect"); const A = await sc.open("A"); await sc.start()
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q4 read the fixture"), holds: { afterChunk: 1500, beforeG3: 1000 }, hooks: { afterChunk: async () => { await A.close(); sc.mark("A_closed_mid_turn"); await sleep(500); await sc.open("A2"); sc.mark("A2_opened_same_session") }, beforeG3: () => sc.snap("before-final") } })
    await sc.snap("final"); return sc.finish()
  },
  async s6_liveness() { // Q6: long gated turn, sampler runs throughout (500 ms)
    const sc = newScenario("s6_liveness"); const A = await sc.open("A"); await sc.start()
    await sleep(1500); sc.mark("idle_baseline_done")
    results[sc.name] = await runTurn(sc, { sender: A, text: prompt("Q6 read the fixture"), holds: { beforeG1: 3000, afterChunk: 3000, beforeG3: 3000 } })
    await sleep(1500); return sc.finish()
  },
  async s5_approval(answerFrom) { // Q5: file_read requires approval; answer from A or B
    const sc = newScenario(`s5_approval_answer_from_${answerFrom}`); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    const seq0 = await lastSeq(); A.send({ type: "message", content: prompt("Q5 read the fixture") }); sc.mark("prompt_sent", { on: "A" })
    const g1 = await gateWait("g1", seq0); await release("g1", g1.marker); await sleep(800); await release("g2", g1.marker); sc.mark("g1_g2_released")
    const gotReq = await until(() => A.count("approval_request") + B.count("approval_request") > 0, 8000)
    sc.mark("approval_request_seen", { seen: gotReq, A: A.count("approval_request"), B: B.count("approval_request") })
    const reqFrame = [...A.frames, ...B.frames].find((f) => f.obj.type === "approval_request")?.obj
    if (!reqFrame) { const g3 = await gateWait("g3", seq0, 4000); if (g3) { await release("g3", g1.marker); await sleep(1500) } }
    if (reqFrame) {
      const answerer = answerFrom === "A" ? A : B
      answerer.send({ type: "approval_response", request_id: reqFrame.request_id, decision: "approve" }); sc.mark("approval_response_sent", { from: answerFrom })
      let g3 = await gateWait("g3", seq0, 7000)
      if (!g3 && answerFrom === "B") { sc.mark("no_progress_7s_after_B_answer__control_answer_from_A"); A.send({ type: "approval_response", request_id: reqFrame.request_id, decision: "approve" }); g3 = await gateWait("g3", seq0, 7000) }
      if (g3) { await release("g3", g1.marker); await until(async () => (await slog()).some((e) => e.kind === "emitted" && e.seq > g3.seq && e.finish === "stop"), 4000) } else sc.mark("phase2_never_reached")
      await sleep(1500)
    }
    await sc.snap("final"); return sc.finish()
  },
  async x1_drop_during_approval() { // EXTRA: owner closes while an approval_request is pending; B attached
    const sc = newScenario("x1_drop_during_approval"); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    const seq0 = await lastSeq(); A.send({ type: "message", content: prompt("X1 read the fixture") }); sc.mark("prompt_sent", { on: "A" })
    const g1 = await gateWait("g1", seq0); await release("g1", g1.marker); await sleep(800); await release("g2", g1.marker)
    const gotReq = await until(() => A.count("approval_request") > 0, 8000); sc.mark("approval_request_seen_on_A", { seen: gotReq, B: B.count("approval_request") })
    await A.close(); sc.mark("A_closed_with_approval_pending"); await sleep(2500); await sc.snap("2.5s-after-drop")
    const g3 = await gateWait("g3", seq0, 6000); sc.mark(g3 ? "phase2_request_seen" : "phase2_request_not_seen_6s")
    if (g3) { await release("g3", g1.marker); await sleep(1500) }
    await sleep(1000); await sc.snap("final"); return sc.finish()
  },
  async x2_prompt_B_inflight() { // EXTRA: B sends a second prompt while A's turn is in flight (gated at g2)
    const sc = newScenario("x2_prompt_B_inflight"); const A = await sc.open("A"); const B = await sc.open("B"); await sc.start()
    const seq0 = await lastSeq(); A.send({ type: "message", content: prompt("X2 first prompt from A") }); sc.mark("prompt_A_sent")
    const g1 = await gateWait("g1", seq0); await release("g1", g1.marker); await sleep(800)
    const seqB = await lastSeq(); B.send({ type: "message", content: prompt("X2 second prompt from B") }); sc.mark("prompt_B_sent_while_A_inflight")
    await sleep(2500); const concurrent = (await slog()).filter((e) => e.kind === "gate_wait" && e.gate === "g1" && e.seq > seqB); sc.mark("second_request_reached_stub_while_A_gated", { seen: concurrent.length > 0 })
    await sc.snap("B-prompt+2.5s")
    await release("g2", g1.marker); const g3 = await gateWait("g3", seq0, 6000); if (g3) { await release("g3", g1.marker); sc.mark("A_turn_finished_at_stub") }
    const g1b = await gateWait("g1", seqB, 8000)
    if (g1b) { sc.mark("second_turn_g1_waiting", { marker: g1b.marker }); await release("g1", g1b.marker); await sleep(800); await release("g2", g1b.marker); const g3b = await gateWait("g3", seqB, 6000); if (g3b) await release("g3", g1b.marker); await sleep(1500) } else sc.mark("second_turn_never_reached_stub_8s")
    await sc.snap("final"); return sc.finish()
  },
}

const plan = MODE === "extra-approval" ? [["x1_drop_during_approval"]] : MODE === "extra-main" ? [["x2_prompt_B_inflight"]] : APPROVAL ? [["s5_approval", "A"], ["s5_approval", "B"]] : [["s1a_both_before"], ["s1b_B_midturn"], ["s1c_B_after_done"], ["s2_prompt_from_B"], ["s3a_owner_drop"], ["s3b_owner_drop_B_attached"], ["s4_reconnect"], ["s6_liveness"]]
const only = process.env.ONLY?.split(",")
for (const [fn, arg] of plan) {
  if (only && !only.includes(fn)) continue
  try { await ALL[fn](arg); console.log("scenario done", fn, arg ?? "", results) } catch (e) { console.log("scenario ERROR", fn, String(e)); results[fn + ":error"] = String(e) }
}
ev.write("scenario-results.json", results)
const gwIdentityEnd = procIdentity(gw.proc.pid)
fs.copyFileSync(stubLogFile, path.join(EVD, "stub-oracle.full.jsonl"))
ev.write("gateway-stdout.txt", fs.readFileSync(path.join(RUN, "logs", "gateway.out"), "utf8").replaceAll(RUN, "<RUN>").slice(0, 400000))
const report = await cleanup(ev)
ev.write("cleanup-report.json", { gateway_identity_start: gw.identity, gateway_identity_end: gwIdentityEnd, report })
console.log("cleanup", JSON.stringify(report))
process.exit(0)
