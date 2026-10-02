// Case driver: owns all resources, serialized cases, independent stream readers. Throwaway.
// Usage: bun scripts/run-spike.mjs <zeroclaw-binary> <run-dir> <evidence-dir>
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { Evidence, mono, procIdentity, freePort, spawnOwned, waitFor, cleanup, owned } from "./harness.mjs"
import { startShim } from "./shim.mjs"

const [BIN, RUN, EVDIR] = process.argv.slice(2)
const DEADLINE_AT = Number(process.env.SPIKE_DEADLINE_EPOCH_MS) // stop-new-actions instant (43 min mark)
const ev = new Evidence(EVDIR)
const timeline = []
const T = (kind, o = {}) => { const r = { mono_ms: mono(), kind, ...o }; timeline.push(r); return r }
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex")
const results = { cases: {}, deadlineFailures: [], notReached: [] }
const stopNew = () => DEADLINE_AT && Date.now() > DEADLINE_AT

fs.rmSync(RUN, { recursive: true, force: true })
for (const d of ["home", "config", "workspace", "logs", "data"]) fs.mkdirSync(path.join(RUN, d), { recursive: true })
const FIXTURE = path.join(RUN, "workspace", "fixture.txt")
const FIXTURE_TEXT = "ldv208-fixture-" + crypto.randomBytes(6).toString("hex") + "\n"
fs.writeFileSync(FIXTURE, FIXTURE_TEXT)

// ---- ports + stub ----
const gwPort = await freePort()
const stubPortFile = path.join(RUN, "logs", "stub.port"); const stubLog = path.join(RUN, "logs", "stub-oracle.jsonl"); const fixturePtr = path.join(RUN, "logs", "fixture.path")
fs.writeFileSync(fixturePtr, FIXTURE)
const minimalEnv = { PATH: "/usr/bin:/bin", HOME: path.join(RUN, "home"), LANG: "C.UTF-8", NO_PROXY: "*", RUST_BACKTRACE: "0" }
const stub = spawnOwned("stub-provider", "python3", [path.resolve("scripts/stub_provider.py"), stubPortFile, fixturePtr, stubLog], minimalEnv, path.join(RUN, "logs", "stub.out"))
await waitFor(() => fs.existsSync(stubPortFile) && fs.readFileSync(stubPortFile, "utf8"), 10000, "stub port")
const stubPort = Number(fs.readFileSync(stubPortFile, "utf8")); const STUB = `http://127.0.0.1:${stubPort}`
const stubCtl = async (gate, marker = "*") => { const r = await fetch(`${STUB}/control/release?gate=${gate}&marker=${marker}`, { method: "POST" }); return r.json() }
const stubLogRead = async () => (await fetch(`${STUB}/control/log`)).json()

// ---- config (derived from zeroclaw dev/config.harness-test.toml prior art) ----
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
auto_approve = ["file_read", "file_write", "file_edit", "memory_recall", "memory_store", "calculator", "glob_search", "content_search"]

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
ev.write("config.sanitized.toml", CONFIG.replaceAll(RUN, "<RUN>")) // contains no secrets by construction

// ---- gateway ----
const gwEnv = { ...minimalEnv, ZEROCLAW_CONFIG_DIR: path.join(RUN, "config"), ZEROCLAW_DATA_DIR: path.join(RUN, "data") }
const gwArgs = ["gateway", "start", "-p", String(gwPort), "--host", "127.0.0.1"]
const gw = spawnOwned("zeroclaw-gateway", BIN, gwArgs, gwEnv, path.join(RUN, "logs", "gateway.out"))
const NATIVE = `http://127.0.0.1:${gwPort}`
const t0 = Date.now()
await waitFor(async () => (await fetch(NATIVE + "/health")).ok, 10000, "gateway /health").catch((e) => { results.deadlineFailures.push(String(e)) })
T("gateway_ready", { port: gwPort, waited_ms: Date.now() - t0, identity: gw.identity })
const gwIdentity0 = procIdentity(gw.proc.pid)

const nat = async (m, p, body) => { const r = await fetch(NATIVE + p, { method: m, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }); const text = await r.text(); let j; try { j = JSON.parse(text) } catch {} ; return { status: r.status, ct: r.headers.get("content-type"), json: j, head: text.slice(0, 600) } }

// ---- generic independent SSE reader ----
function sseReader(id, url) {
  const frames = []; const ctl = new AbortController(); let done = false
  const run = (async () => {
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: "text/event-stream" } })
      frames.push({ seq: 0, mono_ms: mono(), reader: id, kind: "connected", status: r.status, ct: r.headers.get("content-type") })
      const dec = new TextDecoder(); let buf = ""
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true })
        let i; while ((i = buf.indexOf("\n\n")) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); frames.push({ seq: frames.length, mono_ms: mono(), reader: id, raw: raw.slice(0, 4000) }) }
      }
      frames.push({ seq: frames.length, mono_ms: mono(), reader: id, kind: "eof" })
    } catch (e) { frames.push({ seq: frames.length, mono_ms: mono(), reader: id, kind: ctl.signal.aborted ? "closed_by_driver" : "error", err: String(e).slice(0, 200) }) } finally { done = true }
  })()
  const parsed = () => frames.map((f) => { if (!f.raw) return f; const d = f.raw.split("\n").find((l) => l.startsWith("data:")); let j; try { j = JSON.parse(d.slice(5).trim()) } catch {} ; return { ...f, json: j } })
  return { id, frames, parsed, close: () => ctl.abort(), run, isDone: () => done,
    async waitFor(pred, ms, what) { const end = Date.now() + ms; for (;;) { const hit = parsed().find(pred); if (hit) return hit; if (Date.now() > end) { results.deadlineFailures.push(`${id}: ${what} (${ms}ms)`); return null } await Bun.sleep(50) } } }
}

const shimTrace = []
const shim = startShim({ nativeBase: NATIVE, agent: "default", onTrace: (o) => shimTrace.push(o) })
const SHIM = `http://127.0.0.1:${shim.port}`
const sh = async (m, p, body) => { const r = await fetch(SHIM + p, { method: m, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }); const text = await r.text(); let j; try { j = JSON.parse(text) } catch {} ; return { status: r.status, json: j, head: text.slice(0, 500) } }

async function main() {
  // ===== Case 2: native route probes (owned disposable resources only) =====
  const probes = []
  for (const [m, p] of [["GET", "/health"], ["GET", "/api/health"], ["GET", "/api/sessions"], ["GET", "/api/sessions/running"], ["GET", "/api/events/history"], ["GET", "/api/status"], ["GET", "/api/config/agent-options"], ["GET", "/api/tools"], ["GET", "/session"], ["GET", "/event"], ["GET", "/permission"], ["GET", "/question"], ["GET", "/agent"], ["GET", "/provider"]]) {
    if (p === "/event") { probes.push({ m, p, note: "skipped GET (would hang if it were an SSE route; absence established statically)" }); continue }
    const r = await nat(m, p).catch((e) => ({ err: String(e) })); probes.push({ m, p, status: r.status, ct: r.ct, head: r.head?.slice(0, 300) ?? r.err })
  }
  results.cases.nativeProbes = probes; T("native_probes_done")

  // ===== Case 3: core persisted prompt =====
  const created = await sh("POST", "/session", { title: "ldv208 core" }); const SID = created.json.id; const sessObj = shim.sessions.get(SID); const NID = sessObj.nativeID
  T("session_created_via_shim", { shimSessionID: SID, nativeSessionID: NID, status: created.status })
  const natListBefore = await nat("GET", "/api/sessions"); T("native_session_list_before_prompt", { status: natListBefore.status, head: natListBefore.head.slice(0, 300) })
  const PROMPT = "Please read the fixture file and report. nonce=" + crypto.randomBytes(4).toString("hex")
  const pr = await sh("POST", `/session/${SID}/prompt_async`, { parts: [{ type: "text", text: PROMPT }] })
  T("prompt_async_submitted", { status: pr.status, prompt_sha: sha(PROMPT).slice(0, 16) })
  // independent persistence query direct to native (not via shim)
  let persistedHit = null
  const tp = Date.now()
  while (Date.now() - tp < 8000) { const r = await nat("GET", `/api/sessions/${NID}/messages`).catch(() => null); const msgs = r?.json?.messages ?? []; if (msgs.some((m) => m.role === "user" && String(m.content).includes(PROMPT))) { persistedHit = { elapsed_ms: Date.now() - tp, messages: msgs.map((m) => ({ role: m.role, content_head: String(m.content).slice(0, 120), created_at: m.created_at })) }; break } await Bun.sleep(200) }
  const stubAfterSubmit = await stubLogRead()
  const stubReq1 = stubAfterSubmit.find((r) => r.kind === "request_received" && r.phase === 1)
  T("prompt_persistence_probe", { persisted_before_any_model_output: !!persistedHit, stub_received_prompt: !!stubReq1, elapsed_ms: persistedHit?.elapsed_ms })
  results.cases.corePrompt = { PROMPT_sha: sha(PROMPT), persistedHit, stubReq1 }
  if (!persistedHit) results.deadlineFailures.push("prompt persistence not observed natively within 8s while model output gated (probe window shortened to save time)")

  // ===== Case 4: stream, tool call, completion =====
  const natSse = sseReader("native-/api/events", NATIVE + "/api/events"); const shimSse = sseReader("shim-/event", SHIM + "/event")
  await shimSse.waitFor((f) => f.json?.type === "server.connected", 10000, "shim server.connected"); T("streams_attached")
  const marker = stubReq1?.marker
  await stubCtl("g1", marker); T("stub_g1_released", { marker })
  const markerHit = await shimSse.waitFor((f) => JSON.stringify(f.json ?? "").includes(marker ?? "NOMARKER"), 20000, "marker in shim stream"); T("marker_observed", { observed: !!markerHit, event_type: markerHit?.json?.type })
  await stubCtl("g2", marker); T("stub_g2_released")
  const toolCall = await shimSse.waitFor((f) => f.json?.type === "message.part.updated" && f.json?.properties?.part?.type === "tool" && f.json.properties.part.state.status === "running", 20000, "tool call running")
  const toolDone = await shimSse.waitFor((f) => f.json?.type === "message.part.updated" && f.json?.properties?.part?.type === "tool" && f.json.properties.part.state.status === "completed", 20000, "tool completed")
  T("tool_events", { call: !!toolCall, result: !!toolDone })
  const stubMid = await stubLogRead(); const stubReq2 = stubMid.find((r) => r.kind === "request_received" && r.phase === 2)
  T("stub_phase2_request_seen", { seen: !!stubReq2, tool_content_sha: stubReq2?.last_tool_content_sha })
  await stubCtl("g3", marker); T("stub_g3_released")
  const idle = await shimSse.waitFor((f) => f.json?.type === "session.idle", 20000, "session.idle"); T("completion_event_observed", { observed: !!idle })
  // independent completion persistence check (native message store + native session state), NOT the shim label
  let finalPersisted = null; const tf = Date.now()
  while (Date.now() - tf < 20000) { const r = await nat("GET", `/api/sessions/${NID}/messages`); const msgs = r.json?.messages ?? []; if (msgs.some((m) => m.role === "assistant" && String(m.content).includes("FINAL " + marker))) { finalPersisted = { elapsed_ms: Date.now() - tf, messages: msgs.map((m) => ({ role: m.role, content_head: String(m.content).slice(0, 200), created_at: m.created_at })) }; break } await Bun.sleep(200) }
  const stateAfter = await nat("GET", `/api/sessions/${NID}/state`)
  T("completion_persisted_probe", { persisted: !!finalPersisted, native_state: stateAfter.json ?? stateAfter.head })
  const stubFinal = await stubLogRead()
  const lastLine = shimSse.parsed().filter((f) => f.json?.id).at(-1)
  results.cases.stream = { marker, fixtureSha: sha(FIXTURE_TEXT).slice(0, 16), fixtureText: FIXTURE_TEXT.trim(), toolCall: toolCall?.json, toolDone: toolDone?.json, finalPersisted, stateAfter: stateAfter.json }
  const nativeMsgsFinal = await nat("GET", `/api/sessions/${NID}/messages`); const shimMsgsFinal = await sh("GET", `/session/${SID}/message`)
  const natList = await nat("GET", "/api/sessions"); const natHist = await nat("GET", "/api/events/history")
  ev.write("native-messages-final.json", nativeMsgsFinal.json); ev.write("shim-messages-final.json", shimMsgsFinal.json); ev.write("native-session-list.json", natList.json); ev.write("native-events-history-after-completion.json", natHist.json)

  // ===== Case 5: reconnect after completion =====
  const cursorSaved = lastLine?.json?.id ?? null
  T("reconnect_cursor_saved", { cursor: cursorSaved, cursor_origin: "shim-generated evt id (native SSE frames carry no id: see raw frames)" })
  const idBefore = procIdentity(gw.proc.pid)
  shimSse.close(); natSse.close(); await Promise.all([shimSse.run, natSse.run]); T("subscribers_closed")
  const idAfter = procIdentity(gw.proc.pid); const sameInstance = idBefore?.starttime_ticks === idAfter?.starttime_ticks && idAfter?.starttime_ticks === gwIdentity0?.starttime_ticks
  const shimSse2 = sseReader("shim-/event#2", SHIM + "/event"); const natSse2 = sseReader("native-/api/events#2", NATIVE + "/api/events")
  await shimSse2.waitFor((f) => f.json?.type === "server.connected", 10000, "shim reconnect connected"); await Bun.sleep(1500)
  T("reconnect_established", { same_gateway_instance: sameInstance, lastEventID_sent: false })
  const stubFinal2 = await stubLogRead()
  const natMsgsAfterRecon = await nat("GET", `/api/sessions/${NID}/messages`)
  results.cases.reconnect = { cursorSaved, sameInstance, replayFramesShim: shimSse2.parsed().filter((f) => f.json && f.json.type !== "server.connected").length, replayFramesNative: natSse2.parsed().filter((f) => f.raw).length, recoveredFromPersistence: (natMsgsAfterRecon.json?.messages ?? []).length }
  shimSse2.close(); natSse2.close(); await Promise.all([shimSse2.run, natSse2.run])
  ev.write("shim-sse-frames-first.jsonl", shimSse.parsed().map((f) => JSON.stringify(f)).join("\n"))
  ev.write("native-sse-frames-first.jsonl", natSse.parsed().map((f) => JSON.stringify(f)).join("\n"))
  ev.write("shim-sse-frames-reconnect.jsonl", shimSse2.parsed().map((f) => JSON.stringify(f)).join("\n"))
  ev.write("native-sse-frames-reconnect.jsonl", natSse2.parsed().map((f) => JSON.stringify(f)).join("\n"))
  ev.write("stub-oracle-core.json", stubFinal2)
  results.core = { SID, NID, marker, PROMPT_sha: sha(PROMPT) }

  // ===== Case 6: optional cancellation then concurrency =====
  if (stopNew()) { results.notReached.push("case6 cancellation/concurrency: deadline"); return }
  if (!process.env.SPIKE_SKIP_OPTIONAL) await optional()
}

async function optional() {
  const c = await sh("POST", "/session", { title: "ldv208 cancel" }); const s = c.json.id; const n = shim.sessions.get(s).nativeID
  const sse = sseReader("shim-/event(cancel)", SHIM + "/event"); await sse.waitFor((f) => f.json?.type === "server.connected", 10000, "connected")
  const P = "cancel-case prompt nonce=" + crypto.randomBytes(3).toString("hex")
  await sh("POST", `/session/${s}/prompt_async`, { parts: [{ type: "text", text: P }] })
  const log0 = await waitFor(async () => { const l = await stubLogRead(); return l.find((r) => r.kind === "request_received" && r.prompt_head.includes(P.slice(0, 30)) && r.phase === 1 && l.some((x) => x.kind === "gate_wait" && x.marker === r.marker && x.gate === "g1")) && l }, 20000, "stub received cancel prompt").catch((e) => { results.deadlineFailures.push(String(e)); return null })
  const mk = log0?.find((r) => r.kind === "request_received" && r.prompt_head.includes(P.slice(0, 30)))?.marker
  T("cancel_prompt_gated", { marker: mk })
  const abort = await sh("POST", `/session/${s}/abort`); T("abort_response", { status: abort.status, body: abort.head })
  await Bun.sleep(2500)
  const stl = await stubLogRead(); const st = await nat("GET", `/api/sessions/${n}/state`); const run = await nat("GET", "/api/sessions/running")
  const events = sse.parsed().filter((f) => f.json).map((f) => f.json.type)
  results.cases.cancel = { marker: mk, abortResponse: abort, stubSawDisconnect: stl.some((r) => r.kind === "client_disconnected" && r.marker === mk), stubGateStillWaiting: stl.some((r) => r.kind === "gate_wait" && r.marker === mk) && !stl.some((r) => r.kind === "gate_open" && r.marker === mk), nativeStateAfter: st.json ?? st.head, nativeRunning: run.json ?? run.head, shimEventTypes: events }
  if (mk) await stubCtl("g1", mk).catch(() => {}) // driver releases leftover gate (cleanup of owned resource)
  sse.close(); await sse.run
  if (stopNew()) { results.notReached.push("case6b concurrency: deadline"); return }
  // concurrency: two sessions, distinct prompts, driver-controlled gates
  const a = (await sh("POST", "/session", {})).json.id, b = (await sh("POST", "/session", {})).json.id
  const sse2 = sseReader("shim-/event(concurrent)", SHIM + "/event"); await sse2.waitFor((f) => f.json?.type === "server.connected", 10000, "connected")
  const PA = "concurrent A alpha " + crypto.randomBytes(2).toString("hex"), PB = "concurrent B beta " + crypto.randomBytes(2).toString("hex")
  await sh("POST", `/session/${a}/prompt_async`, { parts: [{ type: "text", text: PA }] }); await sh("POST", `/session/${b}/prompt_async`, { parts: [{ type: "text", text: PB }] })
  // marker is derived by the stub from the prompt AS RECEIVED (zeroclaw prefixes a date line), so look it up in the stub oracle log
  let oracleNow = []; const mkOf = (P) => oracleNow.find((r) => r.kind === "request_received" && r.phase === 1 && r.prompt_head.includes(P))?.marker
  await waitFor(async () => { oracleNow = await stubLogRead(); return [PA, PB].every((P) => mkOf(P) && oracleNow.some((r) => r.kind === "gate_wait" && r.gate === "g1" && r.marker === mkOf(P))) }, 20000, "both gated").catch((e) => results.deadlineFailures.push(String(e)))
  // release B first, then A (ordering isolation), through to completion
  for (const [P, S] of [[PB, b], [PA, a]]) { const m = mkOf(P); for (const g of ["g1", "g2"]) await stubCtl(g, m); await sse2.waitFor((f) => f.json?.type === "message.part.updated" && f.json.properties.part.type === "tool" && f.json.properties.sessionID === S && f.json.properties.part.state.status === "completed", 20000, `tool done ${S}`); await stubCtl("g3", m); await sse2.waitFor((f) => f.json?.type === "session.idle" && f.json.properties.sessionID === S, 20000, `idle ${S}`) }
  const evs = sse2.parsed().filter((f) => f.json?.properties?.sessionID).map((f) => ({ t: f.json.type, sid: f.json.properties.sessionID, hasA: JSON.stringify(f.json).includes(mkOf(PA)), hasB: JSON.stringify(f.json).includes(mkOf(PB)) }))
  const crossA = evs.filter((e) => e.sid === a && e.hasB).length, crossB = evs.filter((e) => e.sid === b && e.hasA).length
  results.cases.concurrent = { sessions: { a, b }, markers: { A: mkOf(PA), B: mkOf(PB) }, crossContamination: { eventsInA_withB_marker: crossA, eventsInB_withA_marker: crossB }, idleOrder: evs.filter((e) => e.t === "session.idle").map((e) => (e.sid === a ? "A" : "B")) }
  const nA = await nat("GET", `/api/sessions/${shim.sessions.get(a).nativeID}/messages`), nB = await nat("GET", `/api/sessions/${shim.sessions.get(b).nativeID}/messages`)
  results.cases.concurrent.nativePersisted = { A: (nA.json?.messages ?? []).map((m) => `${m.role}:${String(m.content).slice(0, 60)}`), B: (nB.json?.messages ?? []).map((m) => `${m.role}:${String(m.content).slice(0, 60)}`) }
  sse2.close(); await sse2.run
}

let fatal = null
try { await main() } catch (e) { fatal = String(e?.stack ?? e).slice(0, 1500); results.fatal = fatal }
// ---- cleanup (always) ----
try { await stubCtl("g1"); await stubCtl("g2"); await stubCtl("g3") } catch {}
shim.close()
const cleanupReport = await cleanup(ev)
results.cleanup = cleanupReport
results.timeline = timeline
results.stubOracleFinal = await Promise.resolve(fs.readFileSync(stubLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)))
results.gateway = { port: gwPort, args: gwArgs, identity: gwIdentity0, envKeys: Object.keys(gwEnv) }
results.stub = { port: stubPort, identity: stub.identity, envKeys: Object.keys(minimalEnv) }
results.truncations = ev.truncations
ev.write("shim-trace.jsonl", shimTrace.map((o) => JSON.stringify(o)).join("\n"))
ev.write("case-results.json", results)
ev.write("gateway-stdout-tail.txt", fs.existsSync(path.join(RUN, "logs", "gateway.out")) ? fs.readFileSync(path.join(RUN, "logs", "gateway.out"), "utf8").replaceAll(RUN, "<RUN>").slice(-20000) : "")
console.log(JSON.stringify({ fatal, deadlineFailures: results.deadlineFailures, cleanup: cleanupReport.map((r) => [r.name, r.alive_after]), notReached: results.notReached }))
