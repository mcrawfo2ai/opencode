// LDV-199 orchestrator (throwaway). Run ONLY through scratch-run.sh (private /tmp bind).
//   EVIDENCE_DIR=<dir> node run.mjs [--cases=1,2,...] [--dev]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { now, wall, sha256, sleep, Trace, procIdentity, procAlive, procState, bootID, scrub } from "./lib.mjs"
import { Ctx, Daemon, ROOT, tsum } from "./harness.mjs"
import { syntheticInputs, runControls } from "./controls.mjs"
import { compareToOracle, checkIdentity, checkExitCodes, checkOrdering } from "./compare.mjs"
import * as cases from "./cases.mjs"

const PIN = { size: 3138672, sha256: "b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa" }
const SRC_PIN = "591c6999ebceb86f1b4869685d87bc2e10d9a333"
const EVID = process.env.EVIDENCE_DIR
const DL = process.env.NATIVE_PKG_DIR // dir containing native/package/bin/opencode-pty
const DEV = process.argv.includes("--dev")
const only = (process.argv.find((a) => a.startsWith("--cases=")) ?? "").slice(8).split(",").filter(Boolean).map(Number)
const SOFT_MS = 14 * 60 * 1000
const HARD_MS = 15 * 60 * 1000
const CASE_CAP = 60 * 1024 * 1024
const TOTAL_CAP = 124 * 1024 * 1024
if (!EVID || !DL) throw new Error("EVIDENCE_DIR and NATIVE_PKG_DIR required")
if (!fs.existsSync("/tmp/r") && !fs.existsSync("/tmp")) throw new Error("no /tmp")
const probeDir = path.dirname(new URL(import.meta.url).pathname)

fs.mkdirSync(EVID, { recursive: true })
let evidenceBytes = 0
const written = []
function writeEvidence(name, obj, cap = CASE_CAP) {
  let text = JSON.stringify(scrub(obj), null, 1)
  let truncated = false
  if (text.length > cap) {
    text = JSON.stringify({ truncated: true, original_bytes: text.length, note: "exceeded per-file cap" })
    truncated = true
  }
  if (evidenceBytes + text.length > TOTAL_CAP) {
    text = JSON.stringify({ truncated: true, note: "total evidence cap reached" })
    truncated = true
  }
  fs.writeFileSync(path.join(EVID, name), text)
  evidenceBytes += text.length
  written.push({ name, bytes: text.length, sha256: sha256(text), truncated })
}

const ctx = new Ctx()
const run = { started: wall(), mono_start_ms: Math.round(now()), dev: DEV }
const matrix = []

// ---------------- identity + artifact verification ----------------
function verifyArtifact() {
  const src = path.join(DL, "native/package/bin/opencode-pty")
  const bytes = fs.readFileSync(src)
  const info = { source_path: src, size: bytes.length, sha256: sha256(bytes), expected: PIN }
  info.size_ok = bytes.length === PIN.size
  info.sha256_ok = info.sha256 === PIN.sha256
  const pkg = JSON.parse(fs.readFileSync(path.join(DL, "native/package/package.json"), "utf8"))
  info.package = { name: pkg.name, version: pkg.version, os: pkg.os, cpu: pkg.cpu, libc: pkg.libc }
  const glibc = process.report.getReport().header.glibcVersionRuntime
  info.platform = { platform: process.platform, arch: process.arch, libc: glibc ? "gnu" : "musl", glibcVersionRuntime: glibc ?? null, kernel: os.release(), node: process.version }
  info.platform_compatible = process.platform === "linux" && process.arch === "x64" && !!glibc && pkg.version === "0.1.13"
  if (!info.size_ok || !info.sha256_ok || !info.platform_compatible) return { info, blocked: true }
  fs.mkdirSync(path.join(ROOT, "bin"), { recursive: true, mode: 0o700 })
  const exe = path.join(ROOT, "bin/opencode-pty")
  fs.writeFileSync(exe, bytes, { mode: 0o755 })
  fs.chmodSync(exe, 0o755)
  const copy = fs.readFileSync(exe)
  info.run_copy = { path: exe, size: copy.length, sha256: sha256(copy), sha256_ok: sha256(copy) === PIN.sha256 }
  if (!info.run_copy.sha256_ok) return { info, blocked: true }
  return { info, exe }
}

function isolationIdentity() {
  const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((l) => / \/tmp /.test(l))
  const bindSrc = "/home/user/opencode/.spike-scratch/tmp"
  const probeName = `.iso-probe-${process.pid}`
  fs.writeFileSync(path.join("/tmp", probeName), "x")
  const landedInScratch = fs.existsSync(path.join(bindSrc, probeName))
  fs.rmSync(path.join("/tmp", probeName))
  return {
    mnt_ns: fs.readlinkSync("/proc/self/ns/mnt"),
    tmp_mountinfo: mountinfo,
    tmpdir_env: process.env.TMPDIR,
    tmp_probe_landed_in_workspace_scratch: landedInScratch,
    cwd: process.cwd(),
    run_root: ROOT,
    host_boot_id: bootID(),
    harness_process_env_var_count: Object.keys(process.env).length, // count only: names/values of the agent environment are deliberately not recorded
    note: "harness itself runs with the cloud agent environment; daemon/PTY children get explicit allowlist envs (see daemon.identity.env_keys and fixture mode.env_keys)",
  }
}

// ---------------- cleanup ----------------
async function cleanup() {
  const rep = { started: wall(), steps: [], leftovers: [], escalations: [] }
  const step = (s, d) => rep.steps.push({ t_ms: Math.round(now()), step: s, ...d })
  rep.owned = {
    boot_id: bootID(),
    daemons: ctx.daemons.map((d) => ({ tag: d.tag, instance_id: d.instance_id, spawned_pid: d.child?.pid, starttime_ticks: d.procId?.starttime_ticks, exe: d.procId?.exe })),
    fixtures: ctx.fixtures.map((f) => ({ name: f.name, daemon: f.daemon.tag, pty_id: f.ptyId, pid: f.procId?.pid, starttime_ticks: f.procId?.starttime_ticks, comm: f.procId?.comm })),
  }
  for (const fx of ctx.fixtures) fx.releaseAll()
  step("release-gates", { fixtures: ctx.fixtures.length })
  // 1. close every owned NON-owner socket (subscribers, request connections); owner sockets stay until the daemon is shut down
  let closed = 0
  for (const c of ctx.conns) if (!c.closed && !c.label.startsWith("owner-")) (c.destroy(), closed++)
  step("close-owned-non-owner-sockets", { closed })
  await sleep(150)
  // 2. remove only identified owned PTYs, then 3. shut down only the verified daemon
  for (const d of ctx.daemons.filter((x) => procAlive(x.procId))) {
    const ping = await d.oneShot({ op: "ping" }, { label: `cleanup-ping-${d.tag}`, timeout: 3000 }).catch(() => null)
    const verified = ping?.resp?.type === "pong" && ping.resp.instance_id === d.instance_id && ping.resp.pid === d.reg.pid
    step("verify-daemon", { daemon: d.tag, verified, ping_failure: ping?.failure })
    if (!verified) continue
    const l = await d.list({ label: `cleanup-list-${d.tag}`, timeout: 3000 })
    const mine = new Set(ctx.fixtures.filter((f) => f.daemon === d).map((f) => f.ptyId))
    for (const t of l.terminals ?? []) {
      if (!mine.has(t.id)) {
        rep.leftovers.push({ daemon: d.tag, note: "listed PTY not in owned-fixture records; NOT removed", terminal: tsum(t) })
        continue
      }
      const r = await d.oneShot({ op: "terminate", id: t.id }, { label: `cleanup-terminate-${t.id}`, timeout: 3000 })
      step("terminate-owned-pty", { daemon: d.tag, id: t.id, resp: r.resp ?? r.failure })
    }
    const sd = await d.oneShot({ op: "shutdown" }, { label: `cleanup-shutdown-${d.tag}`, timeout: 3000 })
    step("shutdown-daemon", { daemon: d.tag, resp: sd.resp ?? sd.failure })
  }
  const until = now() + 8000
  while (now() < until && ctx.daemons.some((d) => procAlive(d.procId))) await sleep(50)
  // 4. now close the owner sockets
  let ownersClosed = 0
  for (const c of ctx.conns) if (!c.closed) (c.destroy(), ownersClosed++)
  step("close-owner-sockets", { closed: ownersClosed })
  for (const d of ctx.daemons) {
    const st = procState(d.procId)
    step("daemon-state", { daemon: d.tag, state: st, exitInfo: d.exitInfo })
    if (st.startsWith("alive")) {
      const cur = procIdentity(d.procId.pid)
      const same = cur && cur.starttime_ticks === d.procId.starttime_ticks && cur.exe === d.procId.exe
      rep.escalations.push({ target: `daemon:${d.tag}`, identity_rechecked: !!same })
      if (same) {
        try {
          process.kill(d.procId.pid, "SIGTERM")
        } catch {}
        await sleep(1000)
        const cur2 = procIdentity(d.procId.pid)
        if (cur2 && cur2.starttime_ticks === d.procId.starttime_ticks && cur2.state !== "Z") {
          try {
            process.kill(d.procId.pid, "SIGKILL")
          } catch {}
          rep.escalations.push({ target: `daemon:${d.tag}`, signal: "SIGKILL" })
        }
      }
    }
  }
  await sleep(300)
  for (const fx of ctx.fixtures) {
    const st = procState(fx.procId)
    if (st.startsWith("alive")) {
      const cur = procIdentity(fx.procId.pid)
      const same = cur && cur.starttime_ticks === fx.procId.starttime_ticks && (cur.cmdline ?? []).some((a) => a.includes(fx.dir))
      rep.escalations.push({ target: `fixture:${fx.name}`, identity_rechecked: !!same })
      if (same) {
        try {
          process.kill(fx.procId.pid, "SIGKILL")
        } catch {}
        await sleep(100)
      }
    }
  }
  await sleep(300)
  rep.final = {
    daemons: ctx.daemons.map((d) => ({ tag: d.tag, pid: d.procId.pid, state: procState(d.procId), exit: d.exitInfo })),
    fixtures: ctx.fixtures.map((f) => ({ name: f.name, pid: f.procId?.pid, state: procState(f.procId) })),
  }
  // fixtures log SIGHUP/SIGTERM/SIGINT receipt (observational handler that re-raises the default action)
  rep.fixture_signal_logs = Object.fromEntries(ctx.fixtures.map((f) => [f.name, (() => { try { return fs.readFileSync(path.join(f.dir, "signals.log"), "utf8").trim().split("\n").map((l) => l.replace(/^\S+ /, "")) } catch { return null } })()]).filter(([, v]) => v))
  // report-only scan: executable under the run root, or an argv ELEMENT (not substring of a shell -c blob) under the run root
  try {
    for (const p of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      const id = procIdentity(Number(p))
      if (!id || id.pid === process.pid || id.state === "Z") continue
      const hit = (id.exe ?? "").startsWith(ROOT + "/") || (id.cmdline ?? []).some((a) => a.startsWith(ROOT + "/"))
      if (hit) rep.leftovers.push({ pid: id.pid, state: id.state, comm: id.comm, exe: id.exe, argv0: id.cmdline?.[0]?.slice(0, 120), note: "report only; never killed from name" })
    }
  } catch {}
  rep.finished = wall()
  return rep
}

// ---------------- signals scan ----------------
function scanSignals(obj, p = "", out = []) {
  if (!obj || typeof obj !== "object") return out
  if (Buffer.isBuffer(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const pp = p ? `${p}.${k}` : k
    if ((k === "timedOut" || k === "timedOutExit" || k === "timedOutEof") && v === true) out.push({ path: pp, signal: "timed-out" })
    if (k === "ok" && v === false && p.includes("compare")) out.push({ path: pp, signal: "compare-mismatch" })
    if (k === "failure" && v) out.push({ path: pp, signal: `failure:${v}` })
    if (k === "orderingViolations" && Array.isArray(v) && v.length) out.push({ path: pp, signal: "ordering-violation", detail: v })
    if (typeof v === "object") scanSignals(v, pp, out)
  }
  return out
}

// ---------------- main ----------------
let blocked = null
let exe = null
let D1 = null
let current = null
const results = {}
try {
  const art = verifyArtifact()
  run.artifact = art.info
  if (art.blocked) {
    blocked = "artifact identity/platform check failed"
    throw new Error(blocked)
  }
  exe = art.exe
  run.isolation = isolationIdentity()
  run.clock = { clk_tck: Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()), btime_epoch_s: Number((fs.readFileSync("/proc/stat", "utf8").match(/^btime (\d+)/m) ?? [])[1]), uptime_s: fs.readFileSync("/proc/uptime", "utf8").split(" ")[0] }
  if (!run.isolation.tmp_probe_landed_in_workspace_scratch && !DEV) throw new Error("private /tmp bind not verified")
  run.scripts = Object.fromEntries(fs.readdirSync(probeDir).filter((f) => /\.(mjs|sh)$/.test(f)).sort().map((f) => [f, { bytes: fs.statSync(path.join(probeDir, f)).size, sha256: sha256(fs.readFileSync(path.join(probeDir, f))) }]))
  try {
    run.source = { pin: SRC_PIN, git_head: execFileSync("git", ["-C", probeDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() }
  } catch (e) {
    run.source = { pin: SRC_PIN, git_head_error: e.message }
  }

  // offline controls FIRST; refuse to interpret native evidence if they fail
  const ctlSynthetic = runControls(syntheticInputs(), "synthetic-offline")
  writeEvidence("controls-synthetic.json", { when: "before any native launch", results: ctlSynthetic })
  if (!ctlSynthetic.every((c) => c.pass)) {
    blocked = "offline negative controls failed"
    throw new Error(blocked)
  }

  ctx.deadline = now() + SOFT_MS
  run.experiment_started_mono_ms = Math.round(now())
  const expStart = now()
  ctx.trace = new Trace("startup")
  D1 = await new Daemon(ctx, "d1", exe).launch()
  current = D1
  run.daemon_d1 = D1.identity
  writeEvidence("startup.json", { trace: ctx.trace.events })
  const plan = [
    [1, () => cases.case1(ctx, current)],
    [2, () => cases.case2(ctx, current)],
    [3, () => cases.case3(ctx, current)],
    [4, () => cases.case4(ctx, current)],
    [5, () => cases.case5(ctx, current)],
    [6, () => cases.case6(ctx, current)],
    [7, () => cases.case7(ctx, current)],
    [8, () => cases.case8(ctx, current)],
    [9, () => cases.case9(ctx, exe)],
    [10, () => cases.case10(ctx, current, exe)],
    [11, () => cases.case11(ctx, current)],
    [13, () => cases.case13(ctx, current)],
    [12, () => cases.case12(ctx, exe)],
  ]
  for (const [n, fn] of plan) {
    if (only.length && !only.includes(n)) continue
    const c0 = now()
    const rec = { id: n, started_ms: Math.round(c0 - expStart) }
    if (now() > ctx.deadline) {
      rec.status = "not-reached"
      rec.reason = "14-minute stop for new actions reached"
      matrix.push(rec)
      continue
    }
    ctx.trace = new Trace(`case-${n}`)
    ctx.order = []
    ctx.subs = []
    ctx.keep = null
    let result
    try {
      result = await fn()
      if (result?.nextDaemon) {
        current = result.nextDaemon
        run.daemon_d2 = current.identity
        delete result.nextDaemon
      }
      if (result?.daemon12) {
        run.daemon_d3 = result.daemon12.identity
        delete result.daemon12
      }
      rec.status = "completed"
    } catch (e) {
      rec.status = "error"
      rec.error = e.message
      result = { id: n, error: e.message, stack: String(e.stack).split("\n").slice(0, 6) }
    }
    rec.duration_ms = Math.round(now() - c0)
    rec.signals = scanSignals(result)
    if (ctx.keep) results[`keep${n}`] = ctx.keep
    results[n] = result
    results[`order${n}`] = [...ctx.order]
    writeEvidence(`case-${String(n).padStart(2, "0")}.json`, { id: n, run_status: rec.status, duration_ms: rec.duration_ms, result, trace: { dropped: ctx.trace.dropped, events: ctx.trace.events } })
    const ev = written[written.length - 1]
    rec.evidence = { file: ev.name, sha256: ev.sha256, bytes: ev.bytes }
    matrix.push(rec)
    console.error(`[case ${n}] ${rec.status} ${rec.duration_ms}ms signals=${rec.signals.length} t=${Math.round((now() - expStart) / 1000)}s`)
  }
  run.experiment_elapsed_ms = Math.round(now() - expStart)

  // real-data controls: re-apply the same mutators to clones of captured native data / recorded event orders
  try {
    const k2 = results.keep2
    const k3 = results.keep3
    if (k2 && k3) {
      const sub = k2.c2.subs.c1
      const fx = k2.c2.fx
      const o2 = results.order2.filter((e) => e.fx === fx.name)
      const pick = (kind, name) => o2.find((e) => e.kind === kind && (name === undefined || e.name === name))
      const order = [pick("ack", "mid-emitted"), pick("native-running"), pick("gate-release", "exit")].filter(Boolean)
      const exits = []
      for (const s of results[1]?.subcases ?? []) {
        const lc = s.samples?.[2]?.terminal?.lifecycle
        if (lc?.status === "exited") exits.push({ raw: lc.exit_code ?? null, recorded: lc.exit_code ?? null })
      }
      const c13 = results[13]
      if (c13?.list?.lifecycle_raw?.status === "exited") exits.push({ raw: c13.list.lifecycle_raw.exit_code ?? null, recorded: c13.list.lifecycle_raw.exit_code ?? null })
      const real = {
        origin: fx.origin,
        oracle: fx.oracleAfterOrigin(),
        intervals: sub.intervals().filter((i) => i.start >= fx.origin).map((i) => ({ start: i.start, end: i.end, data: Buffer.from(i.data) })),
        order,
        case12: results[12]?.case12Events?.length >= 5 ? results[12].case12Events : [{ kind: "sub-start-observed", sub: "a" }, { kind: "sub-start-observed", sub: "b" }, { kind: "owner-close" }, { kind: "property-observed" }, { kind: "sub-detach", sub: "a" }],
        case12_source: results[12]?.case12Events?.length >= 5 ? "captured case 12 event order" : "synthetic fallback",
        frames: k3.c3.frames.slice(0, 6),
        expectBySocket: k3.c3.expect,
        exits,
      }
      writeEvidence("controls-real.json", {
        when: "after matrix; mutators applied to clones of captured data (case 2 controller live frames, case 2 recorded event order, case 3 identity frames, case 12 event order, recorded native exit codes)",
        inputs: { intervals: real.intervals.length, order_events: order.map((e) => e.kind), case12_source: real.case12_source, exit_codes: exits, frames: real.frames.length },
        results: runControls(real, "native-captured"),
      })
    } else writeEvidence("controls-real.json", { skipped: "case 2/3 data not available" })
  } catch (e) {
    writeEvidence("controls-real.json", { error: e.message, stack: String(e.stack).split("\n").slice(0, 5) })
  }
} catch (e) {
  run.fatal = e.message
  run.fatal_stack = String(e.stack).split("\n").slice(0, 8)
}


// ---------------- cleanup (reserved 60 s) ----------------
const cleanupStart = now()
const cleanupReport = await cleanup()
cleanupReport.duration_ms = Math.round(now() - cleanupStart)
writeEvidence("cleanup.json", cleanupReport)
run.finished = wall()
run.total_elapsed_ms = Math.round(now())
run.matrix_blocked = blocked
writeEvidence("matrix.json", { matrix })
writeEvidence("run.json", { run })
// ---------------- redaction audit ----------------
import("./lib.mjs").then(async () => {
  const text = fs.readdirSync(EVID).filter((f) => f.endsWith(".json")).map((f) => [f, fs.readFileSync(path.join(EVID, f), "utf8")])
  const secretsList = []
  for (const d of ctx.daemons) secretsList.push(d.reg?.token)
  const audit = { files: text.length, daemon_tokens_checked: secretsList.filter(Boolean).length, token_matches: 0, ticket_checked: true, forbidden_patterns: {} }
  for (const [, t] of text) for (const s of secretsList) if (s && t.includes(s)) audit.token_matches++
  for (const [name, re] of Object.entries({ service_json_content: /"token"\s*:\s*"[0-9a-f]{16,}/, github_token: /gh[pousr]_[A-Za-z0-9]{20,}/, aws_key: /AKIA[0-9A-Z]{12,}/, bearer: /Bearer\s+[A-Za-z0-9._-]{20,}/ })) {
    audit.forbidden_patterns[name] = text.filter(([, t]) => re.test(t)).map(([f]) => f)
  }
  audit.ok = audit.token_matches === 0 && Object.values(audit.forbidden_patterns).every((a) => a.length === 0)
  fs.writeFileSync(path.join(EVID, "redaction-audit.json"), JSON.stringify(audit, null, 1))
  console.error("[done]", JSON.stringify({ blocked, fatal: run.fatal, audit_ok: audit.ok, total_s: Math.round(now() / 1000) }))
  process.exit(0)
})
