// LDV-199 serialized cases 1-12. Observations only; no expected-result labels. Throwaway.
import fs from "node:fs"
import path from "node:path"
import { now, sleep, sha256, procIdentity, procState } from "./lib.mjs"
import { compareToOracle, coverage, checkOrdering, checkCase12, checkIdentity } from "./compare.mjs"
import { Daemon, Fixture, Sub, T, tsum, compactResp, PROBE_DIR } from "./harness.mjs"

const esc = (s, n = 160) => JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s)

// ---------- shared steps ----------
async function std(ctx, d, name, code, { group } = {}) {
  const fx = new Fixture(ctx, d, name, code)
  if (group) fx.group = group
  await fx.create()
  await fx.captureOrigin()
  return fx
}
const attachedOnly = (subs) => subs.filter((s) => s.attachResult?.type === "attached")
async function stepStart(fx, subs = []) {
  subs = attachedOnly(subs)
  fx.release("start")
  const a = await fx.ack("started")
  if (!a) return { ok: false, why: "started ack timeout" }
  const w = await fx.waitTail(fx.nativeTailFor(a.oracle_len), T.event, subs)
  return { ok: w.ok, ack: a, expectedTail: fx.nativeTailFor(a.oracle_len), wait: w.ok ? { tail: w.tail } : w }
}
async function stepMid(fx, subs = []) {
  subs = attachedOnly(subs)
  fx.release("mid")
  const a = await fx.ack("mid-emitted")
  if (!a) return { ok: false, why: "mid-emitted ack timeout" }
  const w = await fx.waitTail(fx.nativeTailFor(a.oracle_len), T.event, subs)
  const run = await fx.observeRunning() // native-running observation AFTER the intermediate ack
  return { ok: w.ok && run.running, ack: a, expectedTail: fx.nativeTailFor(a.oracle_len), wait: w.ok ? { tail: w.tail } : w, running: run.running }
}
async function stepExit(fx, subs = [], { gate = "exit", ackName = "exit-stage", listWatch = true } = {}) {
  subs = attachedOnly(subs)
  fx.release(gate)
  const releasedAt = Date.now()
  const procP = fx.procExitWatch()
  const a = await fx.ack(ackName, T.event)
  const proc = await procP
  const out = { exitAck: a, releasedAt, proc: { state: proc.state, timedOut: !!proc.timedOut, after_exit_stage_ms: a ? proc.wall_ms - a.wall_ms : null } }
  if (listWatch) {
    const until = now() + T.event
    let first = null
    let last = null
    while (now() < until) {
      const r = await fx.daemon.find(fx.ptyId, { record: false })
      last = r.terminal
      if (r.terminal?.lifecycle?.status !== "running") {
        first = { wall_ms: Date.now(), terminal: tsum(r.terminal) }
        break
      }
      await sleep(25)
    }
    out.listExited = first ? { ...first, after_exit_stage_ms: a ? first.wall_ms - a.wall_ms : null } : { timedOut: true, last: tsum(last) }
    fx.ctx.trace.add("list-lifecycle-after-exit", { fx: fx.name, ...out.listExited })
  }
  out.subs = {}
  for (const s of subs) {
    const gotExit = await s.waitFor(() => s.exit, T.event)
    const gotEof = await s.waitFor(() => s.eof, 2500)
    out.subs[s.label] = { exit: s.exit, exitAfterStageMs: s.exit && a ? s.exit.wall - a.wall_ms : null, eof: s.eof, eofAfterExit: s.eof && s.exit ? s.eof.wall - s.exit.wall : null, timedOutExit: !gotExit, timedOutEof: !gotEof }
  }
  return out
}
function verifyPreOrigin(fx, sub) {
  const r = sub.replay
  if (!r || r.start !== 0 || r.length < fx.origin || fx.origin < fx.preLen) return null
  return r.data.subarray(fx.origin - fx.preLen, fx.origin).equals(fx.oracle().subarray(0, fx.preLen))
}
function cmpSub(fx, sub) {
  const iv = sub.intervals()
  if (!iv.length) return { intervals: 0, note: "no intervals (no replay bytes and no live frames)" }
  const c = compareToOracle({ intervals: iv, oracle: fx.oracleAfterOrigin(), origin: fx.origin })
  const from = Math.min(...iv.map((i) => i.start))
  const to = Math.max(...iv.map((i) => i.end))
  return { ...c, coverage: coverage(iv, from, to), replayStartBasis: sub.replay?.basis, preOriginVerified: verifyPreOrigin(fx, sub) }
}
const snapshotView = (r) => {
  const j = r.resp
  if (!j) return { failure: r.failure, detail: r.detail }
  if (j.type !== "snapshot") return compactResp(j)
  return { type: "snapshot", terminal: tsum(j.terminal), text_len: j.text.length, text_head: esc(j.text, 120), checkpoint_len: j.checkpoint_base64.length, cursor: [j.cursor_x, j.cursor_y] }
}
async function removeQuietly(d, fx, label) {
  if (!fx?.ptyId) return null
  const r = await d.oneShot({ op: "terminate", id: fx.ptyId }, { label })
  return r.resp ?? { failure: r.failure }
}
function finish(ctx, base) {
  const ord = checkOrdering(ctx.order.filter((e) => ["ack", "native-running", "gate-release"].includes(e.kind)))
  return { ...base, orderingViolations: ord }
}

// ---------- case 1 ----------
export async function case1(ctx, D) {
  const out = { id: 1, title: "unobserved exit0/exit7: list/snapshot at 100ms/1s/5s, late observer", subcases: [] }
  for (const code of [0, 7]) {
    const fx = await std(ctx, D, `c1-exit${code}`, code)
    const sub = { code, ptyId: fx.ptyId, pid: fx.pid, origin: fx.origin, originHead: fx.originHead, preLen: fx.preLen, mode: fx.mode && { echo_off: fx.mode.echo_off, opost_off: fx.mode.opost_off, columns: fx.mode.columns, rows: fx.mode.rows, isTTY: fx.mode.isTTY } }
    sub.start = await stepStart(fx)
    sub.mid = await stepMid(fx)
    const ex = await stepExit(fx, [], { listWatch: false })
    sub.exitStage = ex.exitAck && { wall_ms: ex.exitAck.wall_ms, code: ex.exitAck.extra?.code, oracle_len: ex.exitAck.oracle_len }
    sub.procWitness = ex.proc
    const anchor = ex.exitAck?.wall_ms ?? ex.releasedAt
    sub.samples = []
    for (const dly of [100, 1000, 5000]) {
      const wait = anchor + dly - Date.now()
      if (wait > 0) await sleep(wait)
      const sentAt = Date.now()
      const lr = await D.find(fx.ptyId, { label: `c1-${code}-list-${dly}` })
      const sr = await D.oneShot({ op: "snapshot", id: fx.ptyId }, { label: `c1-${code}-snapshot-${dly}` })
      sub.samples.push({ requested_after_ms: dly, list_sent_after_anchor_ms: sentAt - anchor, list_rtt_ms: lr.rtt_ms, present: !!lr.terminal, terminal: tsum(lr.terminal), snapshot: snapshotView(sr), proc_state: procState(fx.procId) })
    }
    const late = new Sub(ctx, D, fx, `c1-${code}-late`, { role: "observer" })
    await late.attach(0)
    await late.waitFor(() => late.exit, 2500)
    await late.waitFor(() => late.eof, 1500)
    sub.late = { ...late.summary(), compare: cmpSub(fx, late), oracle_total_bytes: fx.oracle().length, final_text_expected_tail: "FINAL " + fx.name }
    late.detach()
    sub.removeAfter = await removeQuietly(D, fx, `c1-${code}-terminate`)
    out.subcases.push(sub)
  }
  return finish(ctx, out)
}

// ---------- case 2 ----------
export async function case2(ctx, D) {
  const out = { id: 2, title: "observer, controller, concurrent subscribers" }
  const fx = await std(ctx, D, "c2", 0)
  const subs = {
    c1: new Sub(ctx, D, fx, "c2-ctl1", { role: "controller", attachmentID: "c2-ctl1" }),
    o1: new Sub(ctx, D, fx, "c2-obs1", { role: "observer", attachmentID: "c2-obs1" }),
    o2: new Sub(ctx, D, fx, "c2-obs2", { role: "observer", attachmentID: "c2-obs2" }),
    c2: new Sub(ctx, D, fx, "c2-ctl2", { role: "controller", attachmentID: "c2-ctl2" }),
    c3: new Sub(ctx, D, fx, "c2-ctl3-takeover", { role: "controller", attachmentID: "c2-ctl3" }),
  }
  await subs.c1.attach(0)
  await subs.o1.attach(fx.origin)
  await subs.o2.attach(0)
  await subs.c2.attach(fx.origin) // second controller request, no takeover
  await subs.c3.attach(fx.origin, { takeover: true })
  await sleep(400)
  out.afterAttach = Object.fromEntries(Object.values(subs).map((s) => [s.label, { role: s.attachResult?.role, generation: s.attachResult?.generation, events: s.events.slice(0, 5) }]))
  const control = await D.oneShot({ op: "control", id: fx.ptyId, attachment_id: "c2-obs1", cols: 80, rows: 24 }, { label: "c2-control-obs1" })
  await sleep(400)
  out.controlOp = { resp: control.resp ?? { failure: control.failure }, eventsAfter: Object.fromEntries(Object.values(subs).map((s) => [s.label, s.events.length])) }
  const all = Object.values(subs)
  out.start = await stepStart(fx, all)
  out.mid = await stepMid(fx, all)
  out.exit = await stepExit(fx, all)
  out.subs = Object.fromEntries(all.map((s) => [s.label, { ...s.summary(), compare: cmpSub(fx, s) }]))
  const ret = await D.find(fx.ptyId, { label: "c2-list-after" })
  const rs = new Sub(ctx, D, fx, "c2-post-exit-observer", { role: "observer" })
  await rs.attach(0)
  await rs.waitFor(() => rs.exit, 2000)
  out.retainedAfterExit = { terminal: tsum(ret.terminal), freshObserver: { ...rs.summary(), compare: cmpSub(fx, rs) } }
  out.finalTailVsExitFinalOffset = Object.fromEntries(all.map((s) => [s.label, { final_offset: s.exit?.final_offset, tail_after: ret.terminal?.output_tail }]))
  rs.detach()
  all.forEach((s) => s.detach())
  out.removeAfter = await removeQuietly(D, fx, "c2-terminate")
  ctx.keep = { c2: { fx, subs } }
  return finish(ctx, out)
}

// ---------- case 3 ----------
export async function case3(ctx, D) {
  const out = { id: 3, title: "explicit identity A1/A2 (groupA) + B1 (groupB)" }
  const gA = `ldv199-groupA-${process.pid}`
  const gB = `ldv199-groupB-${process.pid}`
  const A1 = await std(ctx, D, "c3-A1", 0, { group: gA })
  const A2 = await std(ctx, D, "c3-A2", 0, { group: gA })
  const B1 = await std(ctx, D, "c3-B1", 0, { group: gB })
  const fxs = [A1, A2, B1]
  out.ptys = fxs.map((f) => ({ name: f.name, ptyId: f.ptyId, group: f.group, pid: f.pid, origin: f.origin }))
  const sA1 = new Sub(ctx, D, A1, "c3-sA1", { role: "controller" })
  const sA2 = new Sub(ctx, D, A2, "c3-sA2", { role: "controller" })
  const sB1 = new Sub(ctx, D, B1, "c3-sB1", { role: "controller" })
  const sA2t = new Sub(ctx, D, A2, "c3-sA2-takeover", { role: "controller", attachmentID: "c3-sA2-takeover" })
  const all = [sA1, sA2, sB1, sA2t]
  await sA1.attach(A1.origin)
  await sA2.attach(A2.origin)
  await sB1.attach(B1.origin)
  await sA2t.attach(A2.origin, { takeover: true }) // arbitration change on A2 while A2 stays at its start gate
  const ctl = await D.oneShot({ op: "control", id: A1.ptyId, attachment_id: sA1.attachmentID, cols: 80, rows: 24 }, { label: "c3-control-A1" })
  await sleep(300)
  out.arbitration = { A2: { first: sA2.events, takeover: sA2t.attachResult }, controlA1: ctl.resp ?? { failure: ctl.failure } }
  out.A1start = await stepStart(A1, [sA1])
  out.B1start = await stepStart(B1, [sB1])
  // A2 must remain gated: negative window with independent stimulus witness (A1/B1 started)
  const a2before = sA2.maxEnd
  await sleep(500)
  out.A2gatedWindow = { witness: { A1_started: !!A1.readAck("started"), B1_started: !!B1.readAck("started") }, A2_started_ack: !!A2.readAck("started"), A2_sub_maxEnd_before: a2before, after: sA2.maxEnd, A2_takeover_maxEnd: sA2t.maxEnd }
  out.A1mid = await stepMid(A1, [sA1])
  out.B1mid = await stepMid(B1, [sB1])
  out.A1exit = await stepExit(A1, [sA1])
  out.B1exit = await stepExit(B1, [sB1])
  out.A2_after_A1B1_exit = { lifecycle: (await D.find(A2.ptyId, { label: "c3-list-A2-mid-gate" })).terminal?.lifecycle, procA2: procState(A2.procId) }
  out.A2start = await stepStart(A2, [sA2, sA2t])
  out.A2mid = await stepMid(A2, [sA2, sA2t])
  out.A2exit = await stepExit(A2, [sA2, sA2t])
  // identity binding: per frame (replay + live) by instance/PTY/group/socket, independent of selection
  const expect = {}
  const frames = []
  for (const [s, f] of [[sA1, A1], [sA2, A2], [sB1, B1], [sA2t, A2]]) {
    expect[s.label] = { instance_id: D.instance_id, pty_id: f.ptyId, group_id: f.group }
    const b = s.attachResult?.bind
    const n = (s.replay?.length ? 1 : 0) + s.live.length
    for (let i = 0; i < n; i++) frames.push({ socket: s.label, instance_id: b?.instance_id, pty_id: b?.pty_id, group_id: b?.group_id })
  }
  out.identityViolations = checkIdentity(frames, expect)
  out.identityFramesChecked = frames.length
  const markers = { A1: "c3-A1", A2: "c3-A2", B1: "c3-B1" }
  out.subs = {}
  for (const [s, f] of [[sA1, A1], [sA2, A2], [sB1, B1], [sA2t, A2]]) {
    const text = Buffer.concat(s.intervals().map((i) => i.data)).toString("latin1")
    const foreign = Object.entries(markers).filter(([k]) => markers[k] !== f.name && text.includes(` ${markers[k]}`)).map(([k]) => k)
    out.subs[s.label] = { ...s.summary(), compare: cmpSub(f, s), foreignMarkersSeen: foreign }
  }
  ctx.keep = { c3: { fxs, subs: all, frames, expect } }
  all.forEach((s) => s.detach())
  out.removeAfter = []
  for (const f of fxs) out.removeAfter.push(await removeQuietly(D, f, `c3-terminate-${f.name}`))
  return finish(ctx, out)
}

// ---------- case 4 ----------
export async function case4(ctx, D) {
  const out = { id: 4, title: "foreground child exits 7; outer shell alive behind separate gate; later outer exits 0" }
  const fx = new Fixture(ctx, D, "c4", 0)
  fs.writeFileSync(
    path.join(fx.dir, "child.json"),
    JSON.stringify({ name: "c4-child", dir: fx.dir, oracle: path.join(fx.dir, "child-oracle.bin"), steps: [{ op: "ack", name: "child-running" }, { op: "gate", name: "child" }, { op: "ack", name: "child-exit-stage", extra: { code: 7 } }, { op: "exit", code: 7 }] }),
  )
  await fx.create(null, { program: "/bin/bash", args: [path.join(PROBE_DIR, "fixture-shell.sh"), fx.dir, process.execPath, path.join(PROBE_DIR, "fixture.mjs"), path.join(fx.dir, "child.json")] })
  await fx.captureOrigin()
  out.shellMode = (() => { try { return JSON.parse(fs.readFileSync(path.join(fx.dir, "mode.json"), "utf8")) } catch { return null } })()
  out.modeAfterHasEchoOff = (fs.existsSync(path.join(fx.dir, "mode-after.txt")) && /-echo\b/.test(fs.readFileSync(path.join(fx.dir, "mode-after.txt"), "utf8"))) || false
  out.modeAfterHasOpostOff = (fs.existsSync(path.join(fx.dir, "mode-after.txt")) && /-opost\b/.test(fs.readFileSync(path.join(fx.dir, "mode-after.txt"), "utf8"))) || false
  const obs = new Sub(ctx, D, fx, "c4-observer", { role: "observer" })
  await obs.attach(fx.origin)
  fx.release("start")
  out.started = await fx.ack("started")
  const cr = await fx.ack("child-running", T.event)
  const fgSamples = []
  for (let i = 0; i < 4; i++) {
    const r = await D.find(fx.ptyId, { record: false })
    fgSamples.push({ t: Math.round(now()), fg: r.terminal?.foreground_process, lifecycle: r.terminal?.lifecycle })
    await sleep(100)
  }
  out.childRunning = { ack: cr, childProc: cr ? procIdentity(cr.pid) : null, shellProc: procIdentity(fx.pid), foregroundSamples: fgSamples }
  await fx.observeRunning()
  fx.release("child")
  const ce = await fx.ack("child-exit-stage", T.event)
  const alive = await fx.ack("alive", T.event)
  const w = alive ? await fx.waitTail(fx.nativeTailFor(alive.oracle_len), T.event, [obs]) : null
  out.childExit = { fixtureAck: ce, childCodeFile: (() => { try { return fs.readFileSync(path.join(fx.dir, "child-code.txt"), "utf8").trim() } catch { return null } })(), aliveAck: alive, tailWait: w && (w.ok ? { tail: w.tail } : w) }
  // observation window after child exit: outer shell must still be running; witness = alive ack + native bytes + /proc
  const win = []
  for (let i = 0; i < 8; i++) {
    const r = await D.find(fx.ptyId, { record: false })
    win.push({ t: Math.round(now()), lifecycle: r.terminal?.lifecycle, fg: r.terminal?.foreground_process, shell_proc: procState(fx.procId), child_proc: cr ? procState({ pid: cr.pid, starttime_ticks: out.childRunning.childProc?.starttime_ticks }) : null, obs_exit_event: !!obs.exit })
    await sleep(125)
  }
  out.afterChildExitWindow = win
  out.running = await fx.observeRunning()
  out.exit = await stepExit(fx, [obs], { gate: "outer" })
  out.observerEvents = obs.summary()
  out.observerCompare = cmpSub(fx, obs)
  out.contraryNote = "native lifecycle/exit events in afterChildExitWindow and observerEvents are preserved as received; none is relabelled"
  obs.detach()
  out.removeAfter = await removeQuietly(D, fx, "c4-terminate")
  return finish(ctx, out)
}

// ---------- case 5 ----------
export async function case5(ctx, D) {
  const out = { id: 5, title: "replay/truncation sweep on held-live fixture", sizes: [], unreached: [] }
  const SIZES = [65536, 262144, 1048576, 4194304, 16777216]
  const fx = new Fixture(ctx, D, "c5", 0)
  const steps = [{ op: "mode" }, { op: "emit", text: "READY c5\n" }, { op: "ack", name: "ready" }, { op: "gate", name: "start" }]
  SIZES.forEach((s, i) => steps.push({ op: "records", upto: s, chunk: 262144 }, { op: "ack", name: `size-${s}` }, { op: "gate", name: i === SIZES.length - 1 ? "exit" : `next-${s}` }))
  steps.push({ op: "emit", text: "FINAL c5\n" }, { op: "ack", name: "exit-stage" }, { op: "exit", code: 0 })
  await fx.create(steps)
  await fx.captureOrigin()
  let captured = fx.origin
  let stop = null
  let tailSub = null
  for (let i = 0; i < SIZES.length; i++) {
    const S = SIZES[i]
    if (stop) {
      out.unreached.push({ size: S, reason: `sweep stopped: ${stop}` })
      continue
    }
    ctx.guard(`c5 size ${S}`)
    fx.release(i === 0 ? "start" : `next-${SIZES[i - 1]}`)
    const a = await fx.ack(`size-${S}`, 20000)
    const rec = { size: S, ack: a && { oracle_len: a.oracle_len, wall_ms: a.wall_ms } }
    if (!a) {
      rec.timedOut = "size ack"
      out.sizes.push(rec)
      stop = "timeout"
      continue
    }
    const expected = fx.origin + S
    const w = await fx.waitTail(expected, 20000)
    const lr = await D.find(fx.ptyId, { label: `c5-list-${S}` })
    rec.native = { expectedTail: expected, waited: w.ok, terminal: tsum(lr.terminal) }
    const head = lr.terminal?.output_head
    const tail = lr.terminal?.output_tail
    // live tail subscriber from previous step: compare what it received while this size was emitted
    if (tailSub) {
      await tailSub.waitFor(() => tailSub.maxEnd >= expected, 8000)
      rec.priorTailSubscriber = { label: tailSub.label, attach: tailSub.attachResult, maxEnd: tailSub.maxEnd, frames: tailSub.frameCount, problems: tailSub.problems.slice(0, 5), compare: cmpSub(fx, tailSub) }
      tailSub.detach()
      tailSub = null
    }
    rec.subs = []
    const seen = new Map()
    for (const [name, cur] of [["0", 0], ["captured", captured], ["head", head], ["tail", tail]]) {
      if (cur === undefined || cur === null) continue
      if (name === "tail") {
        const s = new Sub(ctx, D, fx, `c5-${S}-tail`, { role: "observer" })
        await s.attach(cur)
        tailSub = s
        rec.subs.push({ at: name, cursor: cur, ...s.summary(), compare: cmpSub(fx, s) })
        continue
      }
      if (seen.has(cur)) {
        rec.subs.push({ at: name, cursor: cur, sameCursorAs: seen.get(cur) })
        continue
      }
      seen.set(cur, name)
      const s = new Sub(ctx, D, fx, `c5-${S}-at-${name}`, { role: "observer" })
      await s.attach(cur)
      await sleep(150)
      rec.subs.push({ at: name, cursor: cur, ...s.summary(), compare: cmpSub(fx, s), liveWindowFrames: s.frameCount })
      s.detach()
    }
    out.sizes.push(rec)
    const trunc = rec.subs.find((x) => x.attach?.truncated === true)
    const err = rec.subs.find((x) => x.attach && (x.attach.failure || x.attach.unexpected))
    if ((head ?? 0) > 0) stop = `head advanced to ${head} at size ${S}`
    else if (trunc) stop = `truncated=true on subscription at ${trunc.at} (size ${S})`
    else if (err) stop = `attach error on subscription at ${err.at}: ${JSON.stringify(err.attach).slice(0, 160)}`
    rec.stoppedHere = stop
    captured = tail ?? captured
  }
  if (tailSub) tailSub.detach()
  out.capacityUnknownReason = stop
    ? "sweep stopped on first truncation/error; retention capacity beyond the examined sizes is unknown"
    : "no truncation, head advance or error up to the largest examined size; finite measurement, not proof of indefinite retention"
  // held-live fixture is not released; it is removed by explicit native removal (cleanup of an owned fixture)
  const t0 = Date.now()
  out.removeAfter = await removeQuietly(D, fx, "c5-terminate")
  const proc = await fx.procExitWatch(T.event)
  out.afterRemoval = { proc: { state: proc.state, timedOut: !!proc.timedOut, after_ms: proc.wall_ms - t0 } }
  return finish(ctx, out)
}

// ---------- case 6 ----------
export async function case6(ctx, D) {
  const out = { id: 6, title: "same-instance stream loss/reconnect before exit" }
  const fx = await std(ctx, D, "c6", 0)
  const M = new Sub(ctx, D, fx, "c6-measured", { role: "observer", attachmentID: "c6-measured" })
  const W = new Sub(ctx, D, fx, "c6-witness", { role: "observer", attachmentID: "c6-witness" })
  await M.attach(fx.origin)
  await W.attach(fx.origin)
  out.start = await stepStart(fx, [M, W])
  const saved = M.maxEnd
  out.savedCursor = saved
  ctx.trace.add("stream-loss", { sub: M.label, savedCursor: saved })
  M.detach() // close measured subscriber only; owner and witness remain
  const ownerAlive = !D.owner.conn.closed
  out.mid = await stepMid(fx, [W])
  out.witnessAtLoss = { witnessMaxEnd: W.maxEnd, ownerStillOpen: ownerAlive && !D.owner.conn.closed, measuredFramesAfterLoss: M.afterDetach }
  const M2 = new Sub(ctx, D, fx, "c6-measured-reconnect", { role: "observer", attachmentID: "c6-measured" })
  await M2.attach(saved)
  await M2.waitFor(() => M2.maxEnd >= (out.mid.expectedTail ?? 0), T.event)
  out.reconnect = M2.summary()
  out.exit = await stepExit(fx, [W, M2])
  const joined = [...M.intervals(), ...M2.intervals()]
  out.hole_overlap_M1_plus_M2 = coverage(joined, fx.origin, Math.max(...joined.map((i) => i.end)))
  out.compare = { M1: cmpSub(fx, M), M2: cmpSub(fx, M2), W: cmpSub(fx, W), joined: compareToOracle({ intervals: joined, oracle: fx.oracleAfterOrigin(), origin: fx.origin }) }
  out.subs = { M1: M.summary(), M2: M2.summary(), W: W.summary() }
  ;[M2, W].forEach((s) => s.detach())
  out.removeAfter = await removeQuietly(D, fx, "c6-terminate")
  return finish(ctx, out)
}

// ---------- case 7 ----------
export async function case7(ctx, D) {
  const out = { id: 7, title: "stream loss, exit witnessed, then reconnect after exit" }
  const fx = await std(ctx, D, "c7", 7)
  const M = new Sub(ctx, D, fx, "c7-measured", { role: "observer", attachmentID: "c7-measured" })
  const W = new Sub(ctx, D, fx, "c7-witness", { role: "observer", attachmentID: "c7-witness" })
  await M.attach(fx.origin)
  await W.attach(fx.origin)
  out.start = await stepStart(fx, [M, W])
  out.mid = await stepMid(fx, [M, W])
  const saved = M.maxEnd
  out.savedCursor = saved
  M.detach()
  out.exit = await stepExit(fx, [W])
  const exitConfirmed = !!(out.exit.exitAck && !out.exit.proc.timedOut && out.exit.listExited && !out.exit.listExited.timedOut)
  out.exitConfirmedIndependently = exitConfirmed
  if (!exitConfirmed) {
    out.postExitRecovery = "NOT CLAIMED: exit not independently confirmed"
  } else {
    const M2 = new Sub(ctx, D, fx, "c7-measured-reconnect", { role: "observer", attachmentID: "c7-measured" })
    await M2.attach(saved)
    await M2.waitFor(() => M2.exit, 3000)
    await M2.waitFor(() => M2.eof, 2000)
    out.reconnect = { ...M2.summary(), compare: cmpSub(fx, M2) }
    out.joined = { M1_then_M2: compareToOracle({ intervals: [...M.intervals(), ...M2.intervals()], oracle: fx.oracleAfterOrigin(), origin: fx.origin }), coverage: coverage([...M.intervals(), ...M2.intervals()], fx.origin, Math.max(...[...M.intervals(), ...M2.intervals()].map((i) => i.end))) }
    out.eofAloneNote = "EOF is recorded separately from the exited frame; exit is claimed only from fixture exit-stage ack + /proc + native list/exited frame"
    M2.detach()
  }
  out.W = { ...W.summary(), compare: cmpSub(fx, W) }
  W.detach()
  out.removeAfter = await removeQuietly(D, fx, "c7-terminate")
  return finish(ctx, out)
}

// ---------- case 8 ----------
export async function case8(ctx, D) {
  const out = { id: 8, title: "explicit native removal (terminate) of a running fixture" }
  const fx = await std(ctx, D, "c8", 0)
  const M = new Sub(ctx, D, fx, "c8-measured", { role: "controller", attachmentID: "c8-measured" })
  const W = new Sub(ctx, D, fx, "c8-witness", { role: "observer", attachmentID: "c8-witness" })
  await M.attach(fx.origin)
  await W.attach(fx.origin)
  out.start = await stepStart(fx, [M, W])
  out.runningBefore = (await fx.observeRunning()).running
  const t0 = Date.now()
  const rm = await D.oneShot({ op: "terminate", id: fx.ptyId }, { label: "c8-terminate" })
  out.terminate = { wall_ms: t0, rtt_ms: rm.rtt_ms, resp: rm.resp ?? { failure: rm.failure, detail: rm.detail } }
  out.procAtResponse = procState(fx.procId)
  const proc = await fx.procExitWatch(T.event)
  out.procWitness = { state: proc.state, timedOut: !!proc.timedOut, after_terminate_response_ms: proc.wall_ms - t0 }
  await W.waitFor(() => W.exit || W.eof, 4000)
  await M.waitFor(() => M.exit || M.eof, 2000)
  await sleep(300)
  const lr = await D.find(fx.ptyId, { label: "c8-list-after" })
  const sn = await D.oneShot({ op: "snapshot", id: fx.ptyId }, { label: "c8-snapshot-after" })
  const re = new Sub(ctx, D, fx, "c8-attach-after", { role: "observer" })
  await re.attach(0)
  out.after = {
    listPresent: !!lr.terminal,
    listTerminal: tsum(lr.terminal),
    snapshot: snapshotView(sn),
    attachAfter: re.attachResult,
    signalsLog: (() => { try { return fs.readFileSync(path.join(fx.dir, "signals.log"), "utf8").trim().split("\n") } catch { return null } })(),
    fixtureExitStageAck: !!fx.readAck("exit-stage"),
  }
  out.subs = { M: M.summary(), W: W.summary() }
  out.note = "any exit observed after terminate is removal-induced, not spontaneous completion"
  re.detach()
  ;[M, W].forEach((s) => s.detach())
  return finish(ctx, out)
}

// ---------- case 9 ----------
export async function case9(ctx, exe) {
  const out = { id: 9, title: "native owner handoff (socket ownership; not Core process replacement)" }
  const D = await new Daemon(ctx, "d9", exe).launch() // dedicated daemon: owner changes must not affect other cases
  out.daemon = { instance_id: D.instance_id, pid: D.reg.pid, proc: D.procId }
  const fx = await std(ctx, D, "c9", 0)
  const S1 = new Sub(ctx, D, fx, "c9-old-stream-observer", { role: "observer", attachmentID: "c9-old-obs" })
  const S2 = new Sub(ctx, D, fx, "c9-old-stream-controller", { role: "controller", attachmentID: "c9-old-ctl" })
  await S1.attach(fx.origin)
  await S2.attach(fx.origin)
  out.start = await stepStart(fx, [S1, S2])
  const oldOwner = D.owner
  const prep = await D.ownerExchange(oldOwner, { op: "prepare_handoff" })
  if (prep.resp.type === "handoff") registerSecret(prep.resp.ticket)
  out.prepare = { resp: compactResp(prep.resp), problems: prep.problems, expires_in_ms: prep.resp.expires_at ? prep.resp.expires_at - Date.now() : null }
  const sameInstance = async (label) => {
    const reg2 = D.readRegistration()
    const ping = await D.oneShot({ op: "ping" }, { label })
    return { registration_instance_unchanged: reg2.instance_id === D.reg.instance_id, registration_pid_unchanged: reg2.pid === D.reg.pid, registration_socket_unchanged: reg2.socket === D.reg.socket, registration_token_unchanged: reg2.token === D.reg.token, pong: ping.resp, pong_matches: ping.resp?.type === "pong" && ping.resp.instance_id === D.instance_id && ping.resp.pid === D.reg.pid, daemon_proc_state: procState(D.procId) }
  }
  // A. prescribed order: claim with the ticket while the old owner is still connected
  let newOwner = null
  if (prep.resp.type === "handoff") {
    try {
      newOwner = await D.openOwner(prep.resp.ticket)
      out.claimWhileOldOwnerOpen = { resp: newOwner.resp }
    } catch (e) {
      out.claimWhileOldOwnerOpen = { error: e.message }
    }
  }
  out.sameInstanceBeforeOldOwnerClose = await sameInstance("c9-ping-before-old-close")
  out.oldOwnerStillOpenAfterClaimAttempt = !oldOwner.conn.closed
  // B. variant (not the prescribed order): only if A was refused, close the old owner and retry the SAME unspent ticket
  if (!newOwner && prep.resp.type === "handoff") {
    ctx.order.push({ kind: "owner-close-old" })
    ctx.trace.add("owner-close-old", { conn: oldOwner.conn.label, variant: "B-after-A-refused" })
    oldOwner.conn.destroy()
    await sleep(300)
    out.afterOldOwnerClose = { S1: { eof: S1.eof, close: S1.close, exit: S1.exit }, S2: { eof: S2.eof, close: S2.close, exit: S2.exit }, daemon: procState(D.procId), fixture: procState(fx.procId) }
    try {
      newOwner = await D.openOwner(prep.resp.ticket)
      out.claimAfterOldOwnerClose = { resp: newOwner.resp }
    } catch (e) {
      out.claimAfterOldOwnerClose = { error: e.message }
    }
    out.sameInstanceAfterClaim = await sameInstance("c9-ping-after-claim")
  } else if (newOwner) {
    oldOwner.conn.destroy()
  }
  if (newOwner) D.owner = newOwner
  await sleep(300)
  out.afterHandoffAttempt = { S1: { eof: S1.eof, close: S1.close }, S2: { eof: S2.eof, close: S2.close }, daemon: procState(D.procId), fixture: procState(fx.procId), newOwnerClosed: newOwner?.conn.closed ?? null }
  out.mid = await stepMid(fx, [S1, S2])
  const saved = S1.maxEnd
  const S3 = new Sub(ctx, D, fx, "c9-new-observer", { role: "observer", attachmentID: "c9-new-obs" })
  await S3.attach(saved)
  out.exit = await stepExit(fx, [S1, S2, S3])
  out.subs = { S1: { ...S1.summary(), compare: cmpSub(fx, S1) }, S2: { ...S2.summary(), compare: cmpSub(fx, S2) }, S3: { ...S3.summary(), compare: cmpSub(fx, S3) } }
  ;[S1, S2, S3].forEach((s) => s.detach())
  out.removeAfter = await removeQuietly(D, fx, "c9-terminate")
  return finish(ctx, out)
}
import { registerSecret } from "./lib.mjs"
function require_secret(t) {
  registerSecret(t)
}

// ---------- case 10 ----------
export async function case10(ctx, D1, exe) {
  const out = { id: 10, title: "native daemon replacement" }
  const fx = await std(ctx, D1, "c10-old", 0)
  const S1 = new Sub(ctx, D1, fx, "c10-old-observer", { role: "observer", attachmentID: "c10-old-obs" })
  await S1.attach(fx.origin)
  out.start = await stepStart(fx, [S1])
  const oldCursor = S1.maxEnd
  out.old = { instance_id: D1.instance_id, daemon_pid: D1.reg.pid, daemon_proc: D1.procId, ptyId: fx.ptyId, fixture_proc: fx.procId, cursor: oldCursor, token_sha8: sha256(D1.reg.token).slice(0, 8), socket: D1.reg.socket }
  const sd = await D1.oneShot({ op: "shutdown" }, { label: "c10-shutdown" })
  out.shutdown = { resp: sd.resp ?? { failure: sd.failure, detail: sd.detail }, rtt_ms: sd.rtt_ms }
  const t0 = now()
  let stopped = false
  while (now() - t0 < T.request) {
    if (procState(D1.procId) === "gone" || procState(D1.procId) === "zombie") {
      stopped = true
      break
    }
    await sleep(25)
  }
  const pingOld = await D1.oneShot({ op: "ping" }, { label: "c10-ping-old-after-shutdown" })
  out.stopProof = { daemon_proc_state: procState(D1.procId), stopped_by_proc: stopped, after_ms: Math.round(now() - t0), daemon_exit_event: D1.exitInfo, ping_old: pingOld.resp ?? { failure: pingOld.failure, message: pingOld.detail?.message ?? pingOld.message, code: pingOld.code } }
  await sleep(500)
  out.afterShutdown = { fixture_proc: procState(fx.procId), S1: { eof: S1.eof, close: S1.close, exit: S1.exit, errors: S1.errors }, owner_closed: D1.owner.conn.closed }
  const D2 = await new Daemon(ctx, "d2", exe).launch()
  out.new = { instance_id: D2.instance_id, daemon_pid: D2.reg.pid, spawned_pid: D2.child.pid, socket: D2.reg.socket, token_sha8: sha256(D2.reg.token).slice(0, 8), identity_changed: { instance_id: D2.instance_id !== D1.instance_id, pid: D2.reg.pid !== D1.reg.pid, token: D2.reg.token !== D1.reg.token, socket: D2.reg.socket !== D1.reg.socket }, proc: D2.procId }
  const lr = await D2.list({ label: "c10-list-new" })
  out.oldIdOnNew = { listTerminals: (lr.terminals ?? []).map(tsum), contains_old_id: !!lr.terminals?.find((t) => t.id === fx.ptyId) }
  const ghost = new Sub(ctx, D2, fx, "c10-old-id-on-new-instance", { role: "observer", attachmentID: "c10-ghost" })
  await ghost.attach(oldCursor)
  out.oldCursorOnNew = { attach: ghost.attachResult, note: "no old cursor is evidence of cross-instance continuity" }
  ghost.detach()
  const fx2 = await std(ctx, D2, "c10-new", 0)
  const S2 = new Sub(ctx, D2, fx2, "c10-new-observer", { role: "observer", attachmentID: "c10-new-obs" })
  await S2.attach(fx2.origin)
  out.freshStart = await stepStart(fx2, [S2])
  out.freshMid = await stepMid(fx2, [S2])
  out.freshExit = await stepExit(fx2, [S2])
  out.freshCompare = { ...S2.summary(), compare: cmpSub(fx2, S2) }
  S2.detach()
  S1.detach()
  out.removeAfter = await removeQuietly(D2, fx2, "c10-terminate-fresh")
  out.oldFixtureLeftover = procState(fx.procId)
  return { ...finish(ctx, out), nextDaemon: D2 }
}

// ---------- case 11 ----------
export async function case11(ctx, D) {
  const out = { id: 11, title: "explicit detach and repeated detach" }
  const fx = await std(ctx, D, "c11", 0)
  const M = new Sub(ctx, D, fx, "c11-measured", { role: "controller", attachmentID: "c11-measured" })
  const W = new Sub(ctx, D, fx, "c11-witness", { role: "observer", attachmentID: "c11-witness" })
  await M.attach(fx.origin)
  await W.attach(fx.origin)
  out.roles = { M: M.attachResult?.role, W: W.attachResult?.role }
  out.start = await stepStart(fx, [M, W])
  const wEventsBefore = W.events.length
  M.detach()
  const t1 = Date.now()
  M.detach() // repeated explicit detach (local socket close only; no wire op)
  M.detach()
  await sleep(150)
  out.detach = { local_close: M.close, socket_destroyed: M.conn.socket.destroyed, repeated_detach_threw: false, framesAfterLocalDetachSoFar: M.afterDetach }
  const mFramesBefore = M.frameCount
  out.mid = await stepMid(fx, [W])
  await sleep(1000) // socket/callback window after the independent stimulus witness
  out.window = { stimulus_witness: { W_maxEnd: W.maxEnd, expected_mid_tail: out.mid.expectedTail, fixture_mid_ack: !!fx.readAck("mid-emitted") }, M_frames_during_window: M.frameCount - mFramesBefore, M_events_after_detach: M.afterDetach, W_events_since_detach: W.events.slice(wEventsBefore), note: "missing callbacks alone do not prove daemon-side disposal" }
  const M2 = new Sub(ctx, D, fx, "c11-measured-reattach", { role: "observer", attachmentID: "c11-measured" })
  await M2.attach(M.maxEnd)
  out.reattachSameAttachmentID = M2.attachResult
  out.exit = await stepExit(fx, [W, M2])
  out.subs = { M: M.summary(), W: { ...W.summary(), compare: cmpSub(fx, W) }, M2: { ...M2.summary(), compare: cmpSub(fx, M2) } }
  ;[W, M2].forEach((s) => s.detach())
  out.removeAfter = await removeQuietly(D, fx, "c11-terminate")
  return finish(ctx, out)
}

// ---------- case 12 ----------
export async function case12(ctx, exe) {
  const out = { id: 12, title: "owner close with subscribers STILL ACTIVE (separate daemon+fixture)" }
  const D = await new Daemon(ctx, "d3", exe).launch()
  out.daemon = { instance_id: D.instance_id, pid: D.reg.pid, proc: D.procId, runtime_dir: D.rt }
  const fx = await std(ctx, D, "c12", 0)
  const S1 = new Sub(ctx, D, fx, "c12-sub-controller", { role: "controller", attachmentID: "c12-ctl" })
  const S2 = new Sub(ctx, D, fx, "c12-sub-observer", { role: "observer", attachmentID: "c12-obs" })
  await S1.attach(fx.origin)
  await S2.attach(fx.origin)
  out.start = await stepStart(fx, [S1, S2])
  const ev = []
  const mark = (e) => {
    ev.push(e)
    ctx.trace.add(e.kind, e)
  }
  for (const s of [S1, S2]) if (out.start.ok && s.maxEnd >= out.start.expectedTail) mark({ kind: "sub-start-observed", sub: s.label })
  const before = { daemon: procState(D.procId), fixture: procState(fx.procId), S1_open: !S1.conn.closed, S2_open: !S2.conn.closed, owner_open: !D.owner.conn.closed }
  mark({ kind: "owner-close", conn: D.owner.conn.label })
  const tc = Date.now()
  D.owner.conn.destroy() // close owner ONLY
  await sleep(1500)
  out.ownerClose = {
    before,
    at_wall_ms: tc,
    after_1500ms: { daemon: procState(D.procId), daemon_exit_event: D.exitInfo, fixture: procState(fx.procId), S1: { closed: !!S1.close, eof: S1.eof, exit: S1.exit, errors: S1.errors }, S2: { closed: !!S2.close, eof: S2.eof, exit: S2.exit, errors: S2.errors } },
  }
  const ping = await D.oneShot({ op: "ping" }, { label: "c12-ping-after-owner-close" })
  const reg2 = D.readRegistration()
  out.ownerClose.pingAfter = ping.resp ?? { failure: ping.failure, message: ping.detail?.message ?? ping.message, code: ping.code }
  out.ownerClose.registrationAfter = { present: !reg2.error, instance_unchanged: reg2.instance_id === D.reg.instance_id, error: reg2.error }
  // independently gated intermediate observation
  fx.release("mid")
  const a = await fx.ack("mid-emitted", T.event)
  out.mid = { fixtureAck: a }
  let property = false
  if (a) {
    const expected = fx.nativeTailFor(a.oracle_len)
    const got1 = await S1.waitFor(() => S1.maxEnd >= expected, T.event)
    const got2 = await S2.waitFor(() => S2.maxEnd >= expected, got1 ? 2000 : 1000)
    out.mid.observed = { S1: got1, S2: got2, expectedTail: expected, S1_maxEnd: S1.maxEnd, S2_maxEnd: S2.maxEnd }
    property = got1 || got2
    out.mid.nativeRunningAfterAck = (await fx.observeRunning()).running
    out.mid.listAfter = tsum((await D.find(fx.ptyId, { label: "c12-list-after-mid" })).terminal ?? null)
  }
  mark({ kind: property ? "property-observed" : "property-timeout", detail: "mid-bytes via still-active subscribers after owner close" })
  // later exit observation (also independently gated). Exit is released only if the intermediate ack AND a native-running
  // observation were obtained; otherwise it is reported as not reached (the producer is dead; nothing is recreated).
  if (out.mid.nativeRunningAfterAck) {
    fx.release("exit")
    const proc = await fx.procExitWatch(T.event)
    const exitAck = fx.readAck("exit-stage")
    out.exit = { exitStageAck: exitAck, proc: { state: proc.state, timedOut: !!proc.timedOut }, S1_exit: await S1.waitFor(() => S1.exit, 3000), S2_exit: await S2.waitFor(() => S2.exit, 1500), daemon_after: procState(D.procId), fixture_after: procState(fx.procId) }
  } else {
    out.exit = { notReached: "exit gate NOT released: intermediate acknowledgment and/or native-running observation unavailable", daemon_after: procState(D.procId), fixture_after: procState(fx.procId), S1_exit: S1.exit, S2_exit: S2.exit }
  }
  out.subs = { S1: { ...S1.summary(), compare: cmpSub(fx, S1) }, S2: { ...S2.summary(), compare: cmpSub(fx, S2) } }
  // only now (finally): detach
  S1.detach()
  S2.detach()
  out.case12Events = [...ev, ...ctx.order.filter((e) => e.kind === "sub-detach")]
  out.case12OrderViolations = checkCase12(out.case12Events)
  out.removeAfter = procState(D.procId) === "gone" ? { skipped: "daemon gone" } : await removeQuietly(D, fx, "c12-terminate")
  return { ...finish(ctx, out), daemon12: D }
}

// ---------- case 13 (supplementary, not one of the 12 requested cases) ----------
export async function case13(ctx, D) {
  const out = { id: 13, title: "supplementary: external SIGKILL of an identified owned fixture child (does native ever report exit_code null?)" }
  const fx = await std(ctx, D, "c13", 0)
  const W = new Sub(ctx, D, fx, "c13-witness", { role: "observer", attachmentID: "c13-witness" })
  await W.attach(fx.origin)
  out.start = await stepStart(fx, [W])
  out.mid = await stepMid(fx, [W])
  const cur = procIdentity(fx.pid)
  const same = cur && cur.starttime_ticks === fx.procId.starttime_ticks && (cur.cmdline ?? []).some((a) => a.includes(fx.dir))
  out.identityRechecked = { same, pid: fx.pid }
  if (same) {
    const t0 = Date.now()
    process.kill(fx.pid, "SIGKILL")
    ctx.trace.add("external-sigkill", { fx: fx.name, pid: fx.pid, wall_ms: t0 })
    const proc = await fx.procExitWatch(T.event)
    out.procWitness = { state: proc.state, timedOut: !!proc.timedOut, after_kill_ms: proc.wall_ms - t0 }
    const until = now() + T.event
    let term = null
    while (now() < until) {
      const r = await D.find(fx.ptyId, { record: false })
      term = r.terminal
      if (term && term.lifecycle.status !== "running") break
      await sleep(25)
    }
    out.list = { terminal: tsum(term), lifecycle_raw: term?.lifecycle }
    await W.waitFor(() => W.exit, 3000)
    await W.waitFor(() => W.eof, 1500)
    out.witness = { ...W.summary(), compare: cmpSub(fx, W) }
    out.fixtureExitStageAck = !!fx.readAck("exit-stage")
    out.note = "exit via external signal is not a fixture-gated exit; any code/null is reported exactly as received"
  }
  W.detach()
  out.removeAfter = await removeQuietly(D, fx, "c13-terminate")
  return finish(ctx, out)
}
