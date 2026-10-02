// LDV-199 gaps orchestrator (throwaway). Run ONLY through scratch-run.sh (private /tmp bind).
//   EVIDENCE_DIR=<dir> NATIVE_EXE=<path> node run.mjs [--cases=B1,B2,...] [--dev]
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { now, wallMs, sha256, sleep, Evidence, Trace, scrub, procIdentity, sameIdentity, procState, isAlive, bootID, registerSecret, containsSecret, W, MiB } from "./lib.mjs"
import { Ctx, Daemon, ROOT, SCRIPT_DIR, tsum } from "./harness.mjs"
import * as cases from "./cases.mjs"

const EVID = process.env.EVIDENCE_DIR
const EXE = process.env.NATIVE_EXE
const DEV = process.argv.includes("--dev")
const only = (process.argv.find((a) => a.startsWith("--cases=")) ?? "").slice(8).split(",").filter(Boolean)
const PIN = { size: 3138672, sha256: "b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa" }
if (!EVID || !EXE) throw new Error("EVIDENCE_DIR and NATIVE_EXE required")

const ev = new Evidence(EVID)
const trace = new Trace(ev)
const run = { started: new Date().toISOString(), dev: DEV, only: only.length ? only : null }
const results = {}

// ------------------------------------------------ pre-run identity: executable, tools, isolation
const exeBytes = fs.readFileSync(EXE)
const exeStat = fs.lstatSync(EXE)
const exeSha = sha256(exeBytes)
run.executable = { path: EXE, bytes: exeBytes.length, sha256: exeSha, mode: (exeStat.mode & 0o7777).toString(8), symlink: exeStat.isSymbolicLink(), size_ok: exeBytes.length === PIN.size, sha256_ok: exeSha === PIN.sha256 }
const glibc = process.report.getReport().header.glibcVersionRuntime
run.platform = { platform: process.platform, arch: process.arch, libc: glibc ? "gnu" : "musl", glibc: glibc ?? null, kernel: os.release(), node: process.version, boot_id: bootID(), clk_tck: Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim()) }
if (!run.executable.size_ok || !run.executable.sha256_ok || run.executable.symlink || run.platform.platform !== "linux" || run.platform.arch !== "x64" || !glibc) {
  run.blocked = "executable identity or platform mismatch"
  ev.writeJson("run", "run.json", { run })
  console.error("[blocked]", run.blocked)
  process.exit(2)
}

const toolNames = ["bash", "tee", "stty", "stat", "grep", "sort", "mkfifo", "sha256sum", "python3", "node"]
const tools = {}
for (const t of toolNames) {
  const p = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim()
  let ver = null
  try {
    ver = execFileSync(p, t === "stty" || t === "tee" || t === "stat" || t === "sort" || t === "grep" || t === "mkfifo" || t === "sha256sum" ? ["--version"] : t === "bash" ? ["--version"] : ["--version"], { encoding: "utf8" }).split("\n")[0]
  } catch {}
  tools[t] = { path: p, version: ver, sha256: sha256(fs.readFileSync(fs.realpathSync(p))) }
}
run.fixture_tools = tools
ev.writeJson("run", "preflight.json", { tools, note: "fixture uses bash, tee, stty, stat, grep, sort, mkfifo; verifier uses python3" })

const mountinfo = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter((l) => / \/tmp /.test(l))
const probe = path.join("/tmp", `.iso-${process.pid}`)
fs.writeFileSync(probe, "x")
const landed = fs.existsSync(path.join("/home/user/opencode/.spike-scratch/tmp", path.basename(probe)))
fs.rmSync(probe)
run.isolation = { mnt_ns: fs.readlinkSync("/proc/self/ns/mnt"), tmp_mountinfo: mountinfo, tmpdir_env: process.env.TMPDIR, tmp_probe_landed_in_workspace_scratch: landed, run_root: ROOT, harness_process_env_var_count: Object.keys(process.env).length, note: "agent environment names/values are not recorded; daemon and PTY children receive explicit allowlists" }
if (!landed && !DEV) {
  run.blocked = "private /tmp bind not verified"
  ev.writeJson("run", "run.json", { run })
  console.error("[blocked]", run.blocked)
  process.exit(2)
}
run.scripts = Object.fromEntries(fs.readdirSync(SCRIPT_DIR).filter((f) => /\.(mjs|sh)$/.test(f)).sort().map((f) => [f, { bytes: fs.statSync(path.join(SCRIPT_DIR, f)).size, sha256: sha256(fs.readFileSync(path.join(SCRIPT_DIR, f))) }]))
run.allowlists = {
  daemon_env: ["HOME", "LANG", "PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "OPENCODE_PTY_RUNTIME_DIR"],
  fixture_env_supplied: ["PATH", "HOME", "LANG", "TMPDIR", "TERM", "COLORTERM", "SHELL"],
}

const G = new Ctx(ev, trace, EXE, exeSha)
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(path.join(ROOT, "home"), { recursive: true, mode: 0o700 })
trace.add("run-start", { dev: DEV, platform: run.platform, executable: run.executable })

function persistResults() {
  ev.writeJson("run", "results.json", { results })
}
async function runCase(id, fn) {
  if (only.length && !only.includes(id)) return
  if (G.softDeadline !== null && now() > G.softDeadline) {
    results[id] = { id, status: "not-reached", reason: "overall 15-minute budget: 14-minute stop for new actions reached" }
    trace.add("case-not-reached", { id, reason: "overall-budget" })
    return
  }
  const t0 = now()
  G.setCase(id)
  trace.add("case-start", { id })
  try {
    results[id] = await fn()
  } catch (e) {
    results[id] = { id, status: "error", error: String(e.message).slice(0, 500), stack: String(e.stack).split("\n").slice(0, 6) }
    trace.add("case-error", { id, error: String(e.message).slice(0, 500) })
  }
  results[id].duration_ms = Math.round(now() - t0)
  trace.add("case-end", { id, status: results[id].status, duration_ms: results[id].duration_ms })
  persistResults()
  console.error(`[case ${id}] ${results[id].status} ${results[id].duration_ms}ms t=${G.firstLaunch === null ? 0 : Math.round((now() - G.firstLaunch) / 1000)}s`)
}

// ------------------------------------------------ cleanup (identity fenced)
async function cleanup() {
  G.softDeadline = null // the reserved final 60 s is for cleanup only
  G.setCase("cleanup")
  const rep = { started: new Date().toISOString(), steps: [], escalations: [], leftovers: [], errors: [] }
  const step = (s, d = {}) => {
    rep.steps.push({ t_ms: Math.round(now()), step: s, ...d })
    trace.add("cleanup-step", { step: s, ...d })
  }
  rep.owned = {
    boot_id: bootID(),
    daemons: G.daemons.map((d) => ({ tag: d.tag, spawned_pid: d.child?.pid, proc: d.procId, instance_id: d.instance_id ?? null, runtime_dir: d.runtimeDir })),
    fixtures: G.fixtures.map((f) => ({ name: f.name, case: f.caseName, daemon: f.daemon.tag, pty_id: f.ptyId ?? null, pid: f.pid ?? null, proc: f.procId ?? null })),
  }
  try {
    // 1. owned NON-owner sockets
    let closed = 0
    for (const c of G.conns) if (!c.closed && !c.label.startsWith("owner-")) (c.destroy("cleanup"), closed++)
    step("close-owned-non-owner-sockets", { closed })
    await sleep(150)
    // 2. release remaining gates
    for (const f of G.fixtures) if (isAlive(f.procId)) f.releaseAll()
    step("release-remaining-gates")
    await sleep(300)
    // 3. remove only recorded PTYs while ownership/identity is verified; 4. request shutdown
    for (const d of G.daemons.filter((x) => x.procId && isAlive(x.procId))) {
      const idOk = d.verifyIdentity("cleanup")
      const ping = d.reg ? await d.oneShot({ op: "ping" }, { label: `cleanup-ping-${d.tag}`, timeout: 3000 }) : null
      const verified = idOk && ping?.resp?.type === "pong" && ping.resp.instance_id === d.instance_id && ping.resp.pid === d.reg.pid
      step("verify-daemon", { daemon: d.tag, verified, identity_ok: idOk, ping: ping?.resp?.type ?? ping?.failure })
      if (!verified) {
        rep.leftovers.push({ daemon: d.tag, note: "identity/ownership not verified: NOT signalled, NOT shut down by request" })
        continue
      }
      const l = await d.oneShot({ op: "list" }, { label: `cleanup-list-${d.tag}`, timeout: 3000 })
      const mine = new Set(G.fixtures.filter((f) => f.daemon === d).map((f) => f.ptyId))
      for (const t of l?.resp?.terminals ?? []) {
        if (!mine.has(t.id)) {
          rep.leftovers.push({ daemon: d.tag, note: "listed PTY not recorded as owned: NOT removed", terminal: tsum(t) })
          continue
        }
        const r = await d.oneShot({ op: "terminate", id: t.id }, { label: `cleanup-terminate-${t.id}`, timeout: 3000 })
        step("terminate-recorded-pty", { daemon: d.tag, pty_id: t.id, resp: r.resp?.type ?? r.failure })
      }
      const sd = await d.oneShot({ op: "shutdown" }, { label: `cleanup-shutdown-${d.tag}`, timeout: 3000 })
      step("shutdown-request", { daemon: d.tag, resp: sd.resp?.type ?? sd.failure })
      const until = now() + 5000 // 5 s graceful
      while (now() < until && isAlive(d.procId)) await sleep(50)
    }
    // 5. close owner sockets
    let owners = 0
    for (const c of G.conns) if (!c.closed) (c.destroy("cleanup-owner"), owners++)
    step("close-owner-sockets", { closed: owners })
    await sleep(300)
    // 6. escalation: only identity-verified, 5 s per verified escalation
    for (const d of G.daemons) {
      const st = procState(d.procId)
      step("daemon-final-state", { daemon: d.tag, state: st, exit: d.exitInfo })
      if (st.startsWith("alive")) {
        const cur = procIdentity(d.procId.pid)
        const same = sameIdentity(d.procId, cur) && cur.exe === d.procId.exe
        rep.escalations.push({ target: `daemon:${d.tag}`, identity_rechecked: same })
        if (same) {
          process.kill(d.procId.pid, "SIGTERM")
          await sleep(5000)
          const c2 = procIdentity(d.procId.pid)
          if (sameIdentity(d.procId, c2) && c2.state !== "Z") {
            process.kill(d.procId.pid, "SIGKILL")
            rep.escalations.push({ target: `daemon:${d.tag}`, signal: "SIGKILL" })
            await sleep(500)
          }
        }
      }
    }
    for (const f of G.fixtures) {
      if (!f.procId) continue
      const st = procState(f.procId)
      if (st.startsWith("alive")) {
        const cur = procIdentity(f.procId.pid)
        const same = sameIdentity(f.procId, cur) && (cur.cmdline ?? []).some((a) => a.includes(f.dir))
        rep.escalations.push({ target: `fixture:${f.caseName}/${f.name}`, identity_rechecked: same })
        if (same) {
          process.kill(f.procId.pid, "SIGKILL")
          await sleep(300)
        }
      }
    }
    await sleep(300)
  } catch (e) {
    rep.errors.push(String(e.message).slice(0, 300))
  }
  rep.final = {
    daemons: G.daemons.map((d) => ({ tag: d.tag, pid: d.procId?.pid, state: procState(d.procId), exit: d.exitInfo })),
    fixtures: G.fixtures.map((f) => ({ case: f.caseName, name: f.name, pid: f.pid, state: f.procId ? procState(f.procId) : "never-created" })),
  }
  rep.fixture_signal_logs = {}
  try {
    for (const p of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      const id = procIdentity(Number(p))
      if (!id || id.pid === process.pid || id.state === "Z") continue
      if ((id.exe ?? "").startsWith(ROOT + "/") || (id.cmdline ?? []).some((a) => a.startsWith(ROOT + "/") || a.startsWith(SCRIPT_DIR + "/fixture"))) rep.leftovers.push({ pid: id.pid, state: id.state, comm: id.comm, exe: id.exe, argv0: id.cmdline?.[0]?.slice(0, 120), note: "report only; never signalled from name" })
    }
  } catch {}
  rep.leftover_files = { run_root: ROOT, note: "scratch files under the private /tmp bind are not committed" }
  rep.finished = new Date().toISOString()
  return rep
}

// ------------------------------------------------ main
let dB = null
try {
  await runCase("B-daemon", async () => {
    dB = await new Daemon(G, "dB", path.join(ROOT, "rt-B")).launch()
    return { id: "B-daemon", status: dB.reg && dB.owner ? "completed" : "unknown", identity: dB.identity }
  })
  if (dB?.reg && dB.owner) {
    await runCase("B1", () => cases.caseB1(G, dB))
    await runCase("B2", () => cases.caseSignal(G, dB, "B2", "SIGTERM"))
    await runCase("B3", () => cases.caseSignal(G, dB, "B3", "SIGKILL"))
    await runCase("D2", () => cases.caseD2(G, dB))
    await runCase("D3", () => cases.caseD3(G, dB))
  } else for (const id of ["B1", "B2", "B3", "D2", "D3"]) if (!only.length || only.includes(id)) results[id] = { id, status: "unknown", reason: "shared daemon identity not established" }
  await runCase("C", () => cases.caseC(G))
  await runCase("A", () => cases.caseA(G))
} catch (e) {
  run.fatal = String(e.message).slice(0, 500)
  run.fatal_stack = String(e.stack).split("\n").slice(0, 6)
}
// finish observation windows (done inside cases), then cleanup
const cleanupT0 = now()
const cleanupRep = await cleanup()
cleanupRep.duration_ms = Math.round(now() - cleanupT0)
G.setCase("run")
ev.writeJson("run", "cleanup.json", cleanupRep)
persistResults()
run.finished = new Date().toISOString()
run.first_launch_to_end_ms = G.firstLaunch === null ? null : Math.round(now() - G.firstLaunch)
run.within_15_min_budget = run.first_launch_to_end_ms === null ? null : run.first_launch_to_end_ms <= 15 * 60 * 1000
run.evidence_bytes = { total: ev.total, per_case: Object.fromEntries(ev.perCase), limit_hits: ev.limitHits }
run.trace_events = trace.seq

// redaction audit over everything persisted
const audit = { files: 0, bytes: 0, secret_matches: [], pattern_matches: {} }
const pats = { token_like_json: /"token"\s*:\s*"[0-9a-f]{16,}/, github_token: /gh[pousr]_[A-Za-z0-9]{20,}/, aws_key: /AKIA[0-9A-Z]{12,}/, bearer: /Bearer\s+[A-Za-z0-9._-]{20,}/ }
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name)
    if (e.isDirectory()) walk(f)
    else {
      const buf = fs.readFileSync(f)
      audit.files++
      audit.bytes += buf.length
      if (containsSecret(buf)) audit.secret_matches.push(path.relative(EVID, f))
      if (!/\.(bin)$/.test(f)) {
        const text = buf.toString("utf8")
        for (const [k, re] of Object.entries(pats)) if (re.test(text)) (audit.pattern_matches[k] ??= []).push(path.relative(EVID, f))
      }
    }
  }
}
walk(EVID)
audit.ok = audit.secret_matches.length === 0 && Object.keys(audit.pattern_matches).length === 0
audit.note = "memory-only secrets (daemon tokens) were registered for redaction before any write; TX frames, service.json contents and env dumps are never stored"
run.redaction_audit = audit
ev.writeJson("run", "run.json", { run })
console.error("[done]", JSON.stringify({ fatal: run.fatal, within_budget: run.within_15_min_budget, total_s: run.first_launch_to_end_ms && Math.round(run.first_launch_to_end_ms / 1000), audit_ok: audit.ok, evidence_mib: Math.round((ev.total / MiB) * 10) / 10 }))
process.exit(0)
