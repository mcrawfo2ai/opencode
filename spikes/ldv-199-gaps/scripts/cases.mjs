// LDV-199 gaps: cases A (owner-close pre-MID), B (nullable exit code attempts), C (same-dir restart), D (recomparison captures).
// Observations only. Every exit gate is released only after: intermediate ack + W/native bytes + native running while exit is held.
import fs from "node:fs"
import path from "node:path"
import { now, wallMs, sha256, sleep, W, procIdentity, sameIdentity, procState, inventoryDir, bootID } from "./lib.mjs"
import { Daemon, Fixture, Sub, ROOT, tsum } from "./harness.mjs"

// ---------------------------------------------------------------- shared pieces
const markers = (name) => ({
  "start.bin": Buffer.from(`START ${name}\n`),
  "mid.bin": Buffer.from(`MID ${name}\n`),
  "final.bin": Buffer.from(`FINAL ${name}\n`),
  "post.bin": Buffer.from(`POST ${name}\n`),
})
const stdPlan = (code, { post = false } = {}) => [
  "mode",
  "ack ready",
  "gate start",
  "emit start.bin started",
  "gate mid",
  "emit mid.bin mid-emitted",
  ...(post ? ["gate post", "emit post.bin post-emitted"] : []),
  "gate exit",
  "emit final.bin final-emitted",
  `exit ${code} exit-stage`,
]
const records = (tag, from, bytes) => {
  const parts = []
  for (let n = from; n < from + bytes / 64; n++) parts.push(Buffer.from(`R${String(n).padStart(10, "0")}|${sha256(`${tag}:${n}`).slice(0, 51)}\n`, "ascii"))
  return Buffer.concat(parts)
}

async function deliver(subs, expected, ms) {
  const live = subs.filter((s) => s.attachResult?.type === "attached")
  const ok = await Promise.all(live.map((s) => s.waitFor(() => s.maxEnd >= expected, ms)))
  return { ok: ok.every(Boolean) && live.length === subs.length, subs: live.map((s, i) => ({ sub: s.label, max_end_online: s.maxEnd, reached: ok[i] })), expected }
}
async function advance(G, fx, gate, stage, subs) {
  fx.release(gate)
  const ack = await fx.waitAck(stage, W.ack)
  if (!ack) return { ok: false, stage, timedOut: `ack ${stage} not seen within ${W.ack} ms` }
  const expected = fx.expectedTail(ack.oracle_len)
  const del = await deliver(subs, expected, W.event)
  G.trace.add("delivery", { fx: fx.name, stage, expected_tail: expected, ok: del.ok, subs: del.subs })
  return { ok: del.ok, stage, ack, expected_tail: expected, delivery: del }
}
async function startStage(G, fx, subs) {
  const r = await advance(G, fx, "start", "started", subs)
  if (r.ok) fx.freeze("after-start")
  return r
}
async function midStage(G, fx, subs) {
  const r = await advance(G, fx, "mid", "mid-emitted", subs)
  if (!r.ok) return r
  fx.freeze("after-mid")
  fx.midAcked = true
  const run = await fx.running("after intermediate ack, exit gate still held")
  fx.runningAfterMid = run.running
  r.native_running = run.running
  r.ok = r.ok && run.running
  return r
}
function exitPrereq(fx) {
  return fx.midAcked && fx.runningAfterMid && !fx.readAck("exit-stage")
}
async function exitStage(G, fx, subs, { gate = "exit" } = {}) {
  if (!exitPrereq(fx)) {
    G.trace.add("exit-not-reached", { fx: fx.name, reason: "intermediate ack and/or native running while exit held not established" })
    return { reached: false, reason: "prerequisites (intermediate ack + native running with exit held) not established" }
  }
  const live = subs.filter((s) => s.attachResult?.type === "attached")
  fx.release(gate)
  const released = wallMs()
  const procP = fx.procExitWatch()
  const ack = await fx.waitAck("exit-stage", W.ack)
  const proc = await procP
  const out = { reached: true, released_wall_ms: released, exit_stage_ack: ack, proc_witness: { state: proc.state, timedOut: !!proc.timedOut, after_release_ms: proc.wall_ms - released } }
  // keep polling native metadata until it leaves running (raw payloads retained)
  const until = now() + W.event
  let first = null
  while (now() < until) {
    const r = await fx.daemon.sampleFind(`exitwatch-${fx.name}`, fx.ptyId, { label: `exitwatch-${fx.name}` })
    if (r.terminal && r.terminal.lifecycle.status !== "running") {
      first = { wall_ms: wallMs(), terminal: tsum(r.terminal) }
      break
    }
    await sleep(25)
  }
  out.native_list_exit = first ? { ...first, after_exit_stage_ms: ack ? first.wall_ms - Math.round(ack.wall_us / 1000) : null } : { timedOut: true }
  for (const s of live) {
    const gotExit = await s.waitFor(() => s.exit, W.event)
    const gotEof = await s.waitFor(() => s.eof, W.event)
    out[`sub_${s.label}`] = { exited_frame: !!s.exit, eof: !!s.eof, timedOutExit: !gotExit, timedOutEof: !gotEof }
  }
  const fin = fx.freeze("final")
  out.final_oracle = fin
  return out
}
async function anchoredSamples(G, fx, anchorWall, anchorKind, offsets = [100, 1000, 5000]) {
  const out = []
  for (const off of offsets) {
    const wait = anchorWall + off - wallMs()
    if (wait > 0) await sleep(wait)
    const sentAt = wallMs()
    const l = await fx.daemon.sampleFind(`retention-${fx.name}`, fx.ptyId, { label: `ret-list-${off}` })
    const sn = await fx.daemon.oneShot({ op: "snapshot", id: fx.ptyId }, { label: `ret-snapshot-${fx.name}-${off}` })
    out.push({ requested_after_ms: off, actual_after_anchor_ms: sentAt - anchorWall, anchor: anchorKind, list_terminal: tsum(l.terminal), snapshot_response: sn.resp ? { type: sn.resp.type, terminal: tsum(sn.resp.terminal), text_len: sn.resp.text?.length, checkpoint_b64_len: sn.resp.checkpoint_base64?.length } : { failure: sn.failure }, snapshot_rx: sn.rx, proc_state: procState(fx.procId) })
  }
  return out
}
function closeSubs(G, subs, reason) {
  for (const s of subs) {
    if (s.conn && !s.conn.closed) s.detach(reason)
    else if (s.conn) G.trace.add("sub-detach-skipped", { sub: s.label, reason, why: "socket already closed (by peer or earlier local close)" })
  }
}
async function finishCase(G, caseName, { fixtures, subs, extra }) {
  await sleep(120)
  const metas = subs.map((s) => s.finalize())
  const fxs = fixtures.map((f) => {
    const r = f.finalize()
    return { ...f.descriptor(), frozen: r.frozen }
  })
  const dset = new Map()
  for (const f of fixtures) dset.set(f.daemon.tag, f.daemon)
  for (const s of subs) dset.set(s.daemon.tag, s.daemon)
  const daemons = [...dset.values()].map((d) => ({ tag: d.tag, instance_id: d.instance_id ?? null, pid: d.procId?.pid, ping_rx: d.pingRx ?? null, runtime_dir: d.runtimeDir }))
  const rec = { case: caseName, daemons, fixtures: fxs, sockets: metas.filter(Boolean).map((m) => ({ label: m.label, meta: `captures/${m.label}.meta.json`, rx: m.rx.path.replace(`cases/${caseName}/`, ""), index: m.index_file.replace(`cases/${caseName}/`, "") })), evidence_limit_hits: G.ev.limitHits.filter((h) => String(h).startsWith(caseName)), ...extra }
  G.ev.writeJson(caseName, `cases/${caseName}/case.json`, rec)
  return rec
}

// ---------------------------------------------------------------- A: owner close with M/W active, MID proven BEFORE close
export async function caseA(G) {
  G.setCase("A")
  const out = { id: "A", title: "owner close with M/W active; MID proven before close (additional variant, not the original N15 owner-before-MID order)" }
  const D = await new Daemon(G, "dA", path.join(ROOT, "rt-A")).launch()
  if (!D.reg || !D.owner) return { ...out, status: "unknown", reason: "daemon identity not established", identity: D.identity }
  out.daemon = { instance_id: D.instance_id, pid: D.procId.pid, proc: D.procId }
  const fx = new Fixture(G, D, "A", { plan: stdPlan(0, { post: true }), payloads: markers("A") })
  await fx.create()
  await fx.captureOrigin()
  const M = new Sub(G, D, fx, "M", { role: "controller", attachmentID: "M" })
  const Wo = new Sub(G, D, fx, "W", { role: "observer", attachmentID: "W" }) // W is an observer that may perturb the producer
  await M.attach(fx.origin)
  await Wo.attach(fx.origin)
  out.attached = { M: M.attachResult?.type, W: Wo.attachResult?.type }
  out.start = await startStage(G, fx, [M, Wo])
  out.mid = await midStage(G, fx, [M, Wo])
  const prereq = out.start.ok && out.mid.ok && M.attachResult?.type === "attached" && Wo.attachResult?.type === "attached" && !M.conn.closed && !Wo.conn.closed
  G.trace.add("pre-close-state", { prereq, M_open: !M.conn.closed, W_open: !Wo.conn.closed, owner_open: !D.owner.conn.closed, daemon: procState(D.procId), fixture: procState(fx.procId) })
  out.pre_close = { prereq, daemon: procState(D.procId), fixture: procState(fx.procId) }
  if (!prereq) {
    out.status = "not-reached"
    out.reason = "pre-close prerequisites not established; owner NOT closed"
    closeSubs(G, [M, Wo], "case-end-cleanup")
    return { ...out, case_rec: await finishCase(G, "A", { fixtures: [fx], subs: [M, Wo], extra: {} }) }
  }
  // sequenced owner-close action recorded BEFORE any resulting EOF / daemon death / cleanup detach
  const closeRec = G.trace.add("owner-close-action", { conn: D.owner.conn.label, only_owner_socket: true })
  out.owner_close_trace_seq = closeRec.seq
  D.owner.conn.destroy("owner-close-action")
  const tClose = now()
  // finite 10 s observation window over M/W/daemon/fixture; registration/ping/list outcomes recorded when possible
  const samples = []
  let step = 0
  while (now() - tClose < W.window) {
    const reg = D.inspectRegistration()
    const ping = await D.oneShot({ op: "ping" }, { label: `A-win-ping-${step}`, store: false, timeout: 1000 })
    const lst = await D.sample("A-window", { label: `A-win-list-${step}` })
    samples.push({ step, t_after_close_ms: Math.round(now() - tClose), daemon: procState(D.procId), fixture: procState(fx.procId), registration: reg.state === "ok" ? { state: "ok-present" } : { state: reg.state, code: reg.code }, ping: ping.failure ? { failure: ping.failure, code: ping.code } : { type: ping.resp?.type }, list: lst.failure ? { failure: lst.failure, code: lst.code } : { terminals: lst.terminals?.length }, M: { eof: !!M.eof, close: !!M.close, exit: !!M.exit }, W: { eof: !!Wo.eof, close: !!Wo.close, exit: !!Wo.exit } })
    step++
    await sleep(500)
  }
  out.window_1 = { duration_ms: Math.round(now() - tClose), samples_count: samples.length, first: samples[0], last: samples.at(-1), daemon_exit_event: D.exitInfo, samples }
  G.trace.add("window-1-end", { duration_ms: out.window_1.duration_ms, daemon_exit_event: D.exitInfo })
  // separate post-close emission stimulus (may fail because the producer died; never recreated)
  fx.release("post")
  const postAck = await fx.waitAck("post-emitted", W.ack)
  out.post_stimulus = { gate_released: true, ack: postAck, ack_timed_out: !postAck, fixture_after: procState(fx.procId), daemon_after: procState(D.procId) }
  if (postAck) {
    const expected = fx.expectedTail(postAck.oracle_len)
    out.post_stimulus.delivery = await deliver([M, Wo], expected, W.event)
  }
  // exit only if independently acknowledged intermediate AND native running still hold after window 1
  let runningAgain = { running: false, reason: "not checked" }
  if (!D.exitInfo && procState(D.procId).startsWith("alive")) {
    const r = await fx.running("after window 1 (owner closed earlier)")
    runningAgain = r
    fx.runningAfterMid = r.running
  } else {
    fx.runningAfterMid = false
    runningAgain = { running: false, reason: "daemon not alive; native running unverifiable" }
    G.trace.add("native-running-unverifiable", { fx: fx.name, daemon: procState(D.procId) })
  }
  out.running_after_window_1 = runningAgain
  out.exit = await exitStage(G, fx, [M, Wo])
  if (out.exit.reached) {
    // finite second 10 s window already consumed inside exitStage waits; record elapsed explicitly
    out.exit.note = "exit observation bounded by 10 s per expected event"
  }
  G.trace.add("property-observation-end", { M_eof: !!M.eof, W_eof: !!Wo.eof, daemon_exit: D.exitInfo, fixture: procState(fx.procId) })
  // only now may cleanup detach
  closeSubs(G, [M, Wo], "case-end-cleanup")
  out.final = { M: { eof: M.eof, exit: M.exit, close: M.close }, W: { eof: Wo.eof, exit: Wo.exit, close: Wo.close } }
  out.status = "completed"
  out.case_rec = await finishCase(G, "A", { fixtures: [fx], subs: [M, Wo], extra: { owner_close_trace_seq: closeRec.seq, windows: { window_ms: W.window, event_ms: W.event, ack_ms: W.ack } } })
  return out
}

// ---------------------------------------------------------------- B: nullable exit code, bounded attempts
export async function caseB1(G, D) {
  G.setCase("B1")
  const out = { id: "B1", title: "gated normal exit (also D1: representative live-exit capture)" }
  const fx = new Fixture(G, D, "B1", { plan: stdPlan(7), payloads: markers("B1") })
  await fx.create()
  await fx.captureOrigin()
  const M = new Sub(G, D, fx, "M", { role: "observer", attachmentID: "M" })
  const Wo = new Sub(G, D, fx, "W", { role: "observer", attachmentID: "W" })
  await M.attach(fx.origin)
  await Wo.attach(fx.origin)
  out.start = await startStage(G, fx, [M, Wo])
  out.mid = await midStage(G, fx, [M, Wo])
  out.exit = await exitStage(G, fx, [M, Wo])
  const anchor = Wo.exit?.wall_ms ?? (out.exit.exit_stage_ack ? Math.round(out.exit.exit_stage_ack.wall_us / 1000) : wallMs())
  out.samples = await anchoredSamples(G, fx, anchor, Wo.exit ? "W exited-frame receipt (client)" : "fixture exit-stage ack", [100, 1000, 5000])
  closeSubs(G, [M, Wo], "case-end-cleanup")
  out.status = "completed"
  out.case_rec = await finishCase(G, "B1", { fixtures: [fx], subs: [M, Wo], extra: {} })
  return out
}

export async function caseSignal(G, D, caseName, sig) {
  G.setCase(caseName)
  const out = { id: caseName, title: `identified ${sig} exit attempt (bounded)` , signal: sig }
  const fx = new Fixture(G, D, caseName, { plan: stdPlan(0), payloads: markers(caseName) })
  await fx.create()
  await fx.captureOrigin()
  const M = new Sub(G, D, fx, "M", { role: "observer", attachmentID: "M" })
  const Wo = new Sub(G, D, fx, "W", { role: "observer", attachmentID: "W" })
  await M.attach(fx.origin)
  await Wo.attach(fx.origin)
  out.start = await startStage(G, fx, [M, Wo])
  out.mid = await midStage(G, fx, [M, Wo])
  // freshly recheck recorded PID / start / boot identity (and that it is OUR fixture) before signalling
  const cur = procIdentity(fx.pid)
  const ok = sameIdentity(fx.procId, cur) && (cur.cmdline ?? []).some((a) => a.includes(fx.dir)) && cur.state !== "Z"
  G.trace.add("signal-identity-recheck", { fx: fx.name, ok, recorded: { pid: fx.procId.pid, starttime_ticks: fx.procId.starttime_ticks, boot_id: fx.procId.boot_id }, current: cur && { pid: cur.pid, starttime_ticks: cur.starttime_ticks, boot_id: cur.boot_id, state: cur.state } })
  out.identity_recheck_ok = ok
  if (!ok || !out.mid.ok) {
    out.status = "unknown"
    out.reason = !ok ? "identity recheck failed; no signal sent" : "mid prerequisites not established; no signal sent"
    closeSubs(G, [M, Wo], "case-end-cleanup")
    out.case_rec = await finishCase(G, caseName, { fixtures: [fx], subs: [M, Wo], extra: {} })
    return out
  }
  const sentWall = wallMs()
  G.trace.add("signal-sent", { fx: fx.name, signal: sig, pid: fx.pid, wall_ms: sentWall })
  process.kill(fx.pid, sig)
  const procP = fx.procExitWatch(W.event)
  // metadata samples every 100 ms until the lifecycle leaves running or the 10 s event window expires
  const until = now() + W.event
  let firstNonRunning = null
  while (now() < until) {
    const r = await D.sampleFind(`signal-watch-${caseName}`, fx.ptyId, { label: `sigwatch-${caseName}` })
    if (r.terminal && r.terminal.lifecycle.status !== "running") {
      firstNonRunning = { wall_ms: wallMs(), after_signal_ms: wallMs() - sentWall, terminal: tsum(r.terminal) }
      break
    }
    await sleep(100)
  }
  const proc = await procP
  out.native_metadata = firstNonRunning ?? { timedOut: true, deadline_ms: W.event }
  out.proc_witness = { state: proc.state, timedOut: !!proc.timedOut, after_signal_ms: proc.wall_ms - sentWall }
  const sn = await D.oneShot({ op: "snapshot", id: fx.ptyId }, { label: `signal-snapshot-${caseName}` })
  out.snapshot = sn.resp ? { type: sn.resp.type, lifecycle: sn.resp.terminal?.lifecycle } : { failure: sn.failure }
  for (const s of [M, Wo]) {
    const gotExit = await s.waitFor(() => s.exit, 2000)
    const gotEof = await s.waitFor(() => s.eof, W.event)
    out[`sub_${s.label}`] = { exited_frame: !!s.exit, eof: !!s.eof, timedOutExit: !gotExit, timedOutEof: !gotEof }
  }
  out.fixture_exit_stage_ack = !!fx.readAck("exit-stage")
  out.status = "completed"
  closeSubs(G, [M, Wo], "case-end-cleanup")
  out.case_rec = await finishCase(G, caseName, { fixtures: [fx], subs: [M, Wo], extra: { signal: sig } })
  return out
}

// ---------------------------------------------------------------- D2: same-instance before-exit reconnect
export async function caseD2(G, D) {
  G.setCase("D2")
  const out = { id: "D2", title: "same-instance before-exit reconnect (M closes at saved cursor; W/owner stay active)" }
  const fx = new Fixture(G, D, "D2", { plan: stdPlan(0), payloads: markers("D2") })
  await fx.create()
  await fx.captureOrigin()
  const M = new Sub(G, D, fx, "M", { role: "observer", attachmentID: "M" })
  const Wo = new Sub(G, D, fx, "W", { role: "observer", attachmentID: "W" })
  await M.attach(fx.origin)
  await Wo.attach(fx.origin)
  out.start = await startStage(G, fx, [M, Wo])
  const saved = M.maxEnd
  out.saved_cursor_client_view = saved
  G.trace.add("stream-loss", { sub: "M", saved_cursor: saved, owner_open: !D.owner.conn.closed, W_open: !Wo.conn.closed })
  M.detach("measured-loss")
  out.mid = await midStage(G, fx, [Wo])
  const M2 = new Sub(G, D, fx, "M2", { role: "observer", attachmentID: "M" })
  await M2.attach(saved)
  await M2.waitFor(() => M2.maxEnd >= (out.mid.expected_tail ?? 0), W.event)
  const runAgain = await fx.running("after M reconnect, before exit release")
  fx.runningAfterMid = runAgain.running
  out.reconnect = { attach: M2.attachResult, running_before_exit_release: runAgain.running }
  out.exit = await exitStage(G, fx, [Wo, M2])
  closeSubs(G, [M2, Wo, M], "case-end-cleanup")
  out.status = "completed"
  out.case_rec = await finishCase(G, "D2", { fixtures: [fx], subs: [M, M2, Wo], extra: { saved_cursor: saved } })
  return out
}

// ---------------------------------------------------------------- D3: bounded replay / retention
export async function caseD3(G, D) {
  G.setCase("D3")
  const out = { id: "D3", title: "bounded replay/retention: 64 KiB baseline then 4 MiB cumulative in <=256 KiB chunks", stages: [] }
  const CH = 262144
  const payloads = { ...markers("D3"), "base.bin": records("D3", 0, 65536) }
  const plan = ["mode", "ack ready", "gate start", "emit base.bin baseline", "gate phase2"]
  const sizes = []
  let seq = 1024
  let remaining = 4194304 - 65536
  for (let i = 1; remaining > 0; i++) {
    const n = Math.min(CH, remaining)
    const name = `c${String(i).padStart(2, "0")}.bin`
    payloads[name] = records("D3", seq, n)
    seq += n / 64
    remaining -= n
    sizes.push(n)
    plan.push(`emit ${name} chunk${String(i).padStart(2, "0")}`)
  }
  plan.push("gate exit", "emit final.bin final-emitted", "exit 0 exit-stage")
  const fx = new Fixture(G, D, "D3", { plan, payloads })
  await fx.create()
  await fx.captureOrigin()
  const Wo = new Sub(G, D, fx, "W", { role: "observer", attachmentID: "W" })
  await Wo.attach(fx.origin)
  const examineSubs = []
  const examine = async (stage, saved) => {
    const l = await D.sampleFind(`retention-${stage}`, fx.ptyId, { label: `list-${stage}` })
    const t = l.terminal
    const rec = { stage, list: tsum(t), attaches: [] }
    if (!t) return { ...rec, stop: "list failed" }
    for (const [nm, cur] of [["at0", 0], ["saved", saved], ["head", t.output_head], ["tail", t.output_tail]]) {
      const s = new Sub(G, D, fx, `${stage}-${nm}`, { role: "observer", attachmentID: `${stage}-${nm}` })
      examineSubs.push(s)
      await s.attach(cur)
      await sleep(200)
      rec.attaches.push({ at: nm, requested: cur, attach: s.attachResult })
      s.detach("examination-complete")
    }
    const trunc = rec.attaches.find((a) => a.attach?.truncated === true)
    const err = rec.attaches.find((a) => a.attach?.type !== "attached")
    rec.stop = trunc ? `truncation at ${trunc.at}` : err ? `attach error at ${err.at}` : null
    return rec
  }
  // stage 1: 64 KiB baseline
  const s1 = await advance(G, fx, "start", "baseline", [Wo])
  out.baseline = { ok: s1.ok, ack: s1.ack, timedOut: s1.timedOut }
  if (!s1.ok) {
    out.status = "stopped"
    out.reason = s1.timedOut ?? "baseline delivery not confirmed"
  } else {
    fx.freeze("after-baseline")
    fx.midAcked = true // baseline emission acked independently; running proven next
    const run1 = await fx.running("after baseline ack, exit held")
    fx.runningAfterMid = run1.running
    const st1 = await examine("S1", fx.origin)
    out.stages.push(st1)
    if (st1.stop) {
      out.status = "stopped"
      out.reason = `stage 1 ${st1.stop}; 4 MiB stage not run`
    } else {
      // stage 2: remaining chunks, each acked within 5 s; ack timeout is NOT retention evidence
      fx.release("phase2")
      let acked = 0
      let timeout = null
      let last = null
      for (let i = 1; i <= sizes.length; i++) {
        const a = await fx.waitAck(`chunk${String(i).padStart(2, "0")}`, W.ack)
        if (!a) {
          timeout = `chunk${String(i).padStart(2, "0")} ack not seen within ${W.ack} ms`
          break
        }
        acked++
        last = a
      }
      out.chunks = { planned: sizes.length, acked, sizes_first_last: [sizes[0], sizes.at(-1)], timeout }
      if (timeout) {
        out.status = "stopped"
        out.reason = `payload-ack timeout: ${timeout} (not retention evidence)`
      } else {
        const expected = fx.expectedTail(last.oracle_len)
        const del = await deliver([Wo], expected, W.event)
        G.trace.add("delivery", { fx: fx.name, stage: "phase2", expected_tail: expected, ok: del.ok, subs: del.subs })
        out.phase2_delivery = del
        fx.freeze("after-4MiB")
        const run2 = await fx.running("after 4 MiB acked, exit held")
        fx.runningAfterMid = run2.running
        const st2 = await examine("S2", st1.list?.tail ?? fx.origin)
        out.stages.push(st2)
        out.status = "completed"
      }
    }
  }
  // after a successful live phase, release exit and take finite samples at 100 ms / 1 s / 5 s
  if (out.status === "completed") {
    out.exit = await exitStage(G, fx, [Wo])
    const anchor = Wo.exit?.wall_ms ?? (out.exit.exit_stage_ack ? Math.round(out.exit.exit_stage_ack.wall_us / 1000) : wallMs())
    out.retention_samples = await anchoredSamples(G, fx, anchor, Wo.exit ? "W exited-frame receipt (client)" : "fixture exit-stage ack")
    const post = new Sub(G, D, fx, "post-exit-head", { role: "observer", attachmentID: "post-exit-head" })
    examineSubs.push(post)
    const lt = await D.sampleFind("retention-post-exit", fx.ptyId, { label: "ret-post-exit-list" })
    await post.attach(lt.terminal?.output_head ?? 0)
    await sleep(200)
    out.post_exit_head_attach = post.attachResult
    post.detach("examination-complete")
  }
  closeSubs(G, [Wo], "case-end-cleanup")
  out.case_rec = await finishCase(G, "D3", { fixtures: [fx], subs: [Wo, ...examineSubs], extra: { chunk_bytes_max: CH, cumulative_target: 4194304 } })
  return out
}

// ---------------------------------------------------------------- C: same exact runtime-directory restart
export async function caseC(G) {
  G.setCase("C")
  const out = { id: "C", title: "same exact runtime-directory restart" }
  const RT = path.join(ROOT, "rt-C")
  out.runtime_dir_exact = RT
  out.runtime_dir_backing = `/home/user/opencode/.spike-scratch/tmp/${path.relative("/tmp", RT)}`
  const D1 = await new Daemon(G, "C1", RT).launch()
  if (!D1.reg || !D1.owner) return { ...out, status: "unknown", reason: "first daemon identity not established", identity: D1.identity }
  const fx = new Fixture(G, D1, "old", { plan: stdPlan(0), payloads: markers("C-old") })
  await fx.create()
  await fx.captureOrigin()
  const M = new Sub(G, D1, fx, "M", { role: "observer", attachmentID: "M" })
  const Wo = new Sub(G, D1, fx, "W", { role: "observer", attachmentID: "W" })
  await M.attach(fx.origin)
  await Wo.attach(fx.origin)
  out.start = await startStage(G, fx, [M, Wo])
  out.mid = await midStage(G, fx, [M, Wo])
  const oldCursor = M.maxEnd
  out.old = { instance_id: D1.instance_id, pid: D1.procId.pid, proc: D1.procId, pty_id: fx.ptyId, group: fx.group, cursor_client_view: oldCursor, token_sha8: sha256(D1.reg.token).slice(0, 8), socket: D1.reg.socket }
  const inv = (label) => ({ label, runtime_dir: RT, runtime_inventory: inventoryDir(RT), socket_dir: "/tmp/opencode-pty-0", socket_dir_inventory: inventoryDir("/tmp/opencode-pty-0") })
  out.inventory_before_shutdown = inv("before-shutdown")
  G.trace.add("inventory", out.inventory_before_shutdown)
  const idOk = D1.verifyIdentity("before shutdown request")
  const ping = await D1.oneShot({ op: "ping" }, { label: "C-ping-before-shutdown" })
  const verified = idOk && ping.resp?.type === "pong" && ping.resp.instance_id === D1.instance_id && ping.resp.pid === D1.reg.pid
  out.shutdown_verified = verified
  if (!verified) {
    out.status = "stopped"
    out.reason = "identity not verified; shutdown NOT requested"
  } else {
    G.trace.add("shutdown-request-action", { daemon: D1.tag, pid: D1.procId.pid })
    const sd = await D1.oneShot({ op: "shutdown" }, { label: "C-shutdown" })
    out.shutdown = { resp: sd.resp ?? { failure: sd.failure, detail: sd.detail }, rx: sd.rx }
    const t0 = now()
    const stopWatch = await new Promise((resolve) => {
      const tick = () => {
        const st = procState(D1.procId)
        if (!st.startsWith("alive")) return resolve({ state: st, after_ms: Math.round(now() - t0) })
        if (now() - t0 > W.ready) return resolve({ state: st, timedOut: true, after_ms: Math.round(now() - t0) })
        setTimeout(tick, 10)
      }
      tick()
    })
    out.daemon_stop = { ...stopWatch, exit_event: D1.exitInfo, verified_by: "recorded pid+starttime+boot identity" }
    const fxProc = await fx.procExitWatch(W.event)
    out.fixture_after_shutdown = { state: fxProc.state, timedOut: !!fxProc.timedOut, after_ms: fxProc.after_ms }
    for (const s of [M, Wo]) {
      const gotEof = await s.waitFor(() => s.eof, W.event)
      out[`old_stream_${s.label}`] = { eof: !!s.eof, close: !!s.close, exited_frame: !!s.exit, timedOutEof: !gotEof }
    }
    out.inventory_after_shutdown = inv("after-shutdown")
    G.trace.add("inventory", out.inventory_after_shutdown)
    // relaunch the same exact binary in the SAME exact runtime directory; nothing deleted or rewritten
    const D2 = await new Daemon(G, "C2", RT).launch()
    out.relaunch = { ready: D2.identity.ready, ready_ms: D2.identity.ready_ms, polls: D2.polls, identity: { spawned_pid: D2.child.pid, proc: D2.procId } }
    out.inventory_after_relaunch = inv("after-relaunch")
    G.trace.add("inventory", out.inventory_after_relaunch)
    if (!D2.reg || !D2.owner) {
      out.status = "partial"
      out.reason = "new identity not established (readiness failed or timed out); old-ID/old-cursor/fresh-fixture actions are UNKNOWN"
    } else {
      out.identity_compare = {
        instance_changed: D2.instance_id !== D1.instance_id,
        pid_changed: D2.reg.pid !== D1.reg.pid,
        token_changed: D2.reg.token !== D1.reg.token,
        socket_changed: D2.reg.socket !== D1.reg.socket,
        old_instance: D1.instance_id,
        new_instance: D2.instance_id,
        new_pid: D2.reg.pid,
        registration_pid_equals_launched_pid: D2.reg.pid === D2.child.pid,
        starttime_new_vs_old_distinct: D2.procId.starttime_ticks !== D1.procId.starttime_ticks,
      }
      const lst = await D2.sample("C-new-list", { label: "C-new-list" })
      const found = lst.terminals?.find((t) => t.id === fx.ptyId) ?? null
      out.old_id_on_new = { list_terminals: (lst.terminals ?? []).map(tsum), contains_old_id: !!found }
      const snap = await D2.oneShot({ op: "snapshot", id: fx.ptyId }, { label: "C-old-id-snapshot" })
      out.old_id_snapshot = snap.resp ? { type: snap.resp.type, message: snap.resp.message } : { failure: snap.failure, detail: snap.detail }
      const ghost = new Sub(G, D2, fx, "old-cursor-attach", { role: "observer", attachmentID: "ghost" })
      await ghost.attach(oldCursor)
      await ghost.waitFor(() => ghost.eof, W.event)
      out.old_cursor_attach = { requested_cursor: oldCursor, attach: ghost.attachResult, eof: !!ghost.eof, close: !!ghost.close, note: "a changed instance identity is not evidence of old-cursor continuity" }
      ghost.detach("case-end-cleanup")
      // fresh gated PTY on the NEW instance
      const fx2 = new Fixture(G, D2, "new", { plan: stdPlan(0), payloads: markers("C-new") })
      await fx2.create()
      await fx2.captureOrigin()
      const M2 = new Sub(G, D2, fx2, "M2", { role: "observer", attachmentID: "M2" })
      const W2 = new Sub(G, D2, fx2, "W2", { role: "observer", attachmentID: "W2" })
      await M2.attach(fx2.origin)
      await W2.attach(fx2.origin)
      out.fresh_start = await startStage(G, fx2, [M2, W2])
      out.fresh_mid = await midStage(G, fx2, [M2, W2])
      out.fresh_exit = await exitStage(G, fx2, [M2, W2])
      closeSubs(G, [M2, W2], "case-end-cleanup")
      out.status = "completed"
      closeSubs(G, [M, Wo], "case-end-cleanup")
      out.case_rec = await finishCase(G, "C", { fixtures: [fx, fx2], subs: [M, Wo, ghost, M2, W2], extra: { runtime_dir_exact: RT, old_cursor: oldCursor } })
      return out
    }
  }
  closeSubs(G, [M, Wo], "case-end-cleanup")
  out.case_rec = await finishCase(G, "C", { fixtures: [fx], subs: [M, Wo], extra: { runtime_dir_exact: RT, old_cursor: oldCursor } })
  return out
}
