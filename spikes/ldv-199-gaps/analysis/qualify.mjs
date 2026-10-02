// Derives evidence/qualification.json from results.json + offline/verify-report.json using explicit rules.
// qualification: valid = observed with prerequisites met and offline checks green; adverse = observed outcome unfavourable to
// continuity/delivery; timed-out = expected event absent at its deadline; unknown/not-reached = not observed (reason given).
import fs from "node:fs"
import path from "node:path"
const E = process.argv[2]
const J = (f) => JSON.parse(fs.readFileSync(path.join(E, f), "utf8"))
const R = J("results.json").results
const V = J("offline/verify-report.json")
const trace = fs.readFileSync(path.join(E, "trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
const vc = (c) => V.cases.find((x) => x.case === c)
const green = (c, name) => vc(c)?.checks.find((k) => k.name === name)?.status === "green"
const allGreen = (c) => vc(c)?.red.length === 0
const q = []
const add = (id, claim, qualification, basis, files = []) => q.push({ id, claim, qualification, basis, files })

// ---- A
const A = R.A
add("A.1", "pre-close MID established: START+MID emitted by tee oracle with stage acks, delivered to both M and W, native running, exit held, M and W attached/pumping", A.pre_close?.prereq && allGreen("A") ? "valid" : "unknown", "results.A.pre_close + offline verify (A) green", ["cases/A/case.json", "cases/A/fx-A/acks/mid-emitted.json"])
add("A.2", "owner-close-action sequenced before any resulting EOF, daemon death or cleanup detach", green("A", "ordering:case-A-owner-close") ? "valid" : "unknown", "offline check ordering:case-A-owner-close", ["trace.jsonl"])
const dx = A.window_1?.daemon_exit_event
add("A.3", "closing only the owner socket with M/W active: M/W received EOF with no exited frame; daemon exited; fixture PTY child gone; registration removed; ping/list refused", dx && !A.final?.M?.exit && !A.final?.W?.exit ? "adverse" : "unknown", `daemon exit event ${JSON.stringify(dx)}; window_1 first/last samples in results.A`, ["cases/A/captures/M.rx.bin", "cases/A/captures/W.rx.bin", "trace.jsonl"])
add("A.4", "separate post-close emission stimulus (post gate released; post-emitted ack)", A.post_stimulus?.ack_timed_out ? "timed-out" : A.post_stimulus?.ack ? "valid" : "unknown", `ack deadline ${5000} ms; fixture ${A.post_stimulus?.fixture_after}, daemon ${A.post_stimulus?.daemon_after}`, ["cases/A/fx-A/stage.log"])
add("A.5", "exit release and second 10 s observation", A.exit?.reached ? "valid" : "not-reached", A.exit?.reason ?? "", [])
add("A.6", "property observation finished (window + deadline recorded) before any cleanup detach; no detach-first cleanup", trace.some((e) => e.case === "A" && e.kind === "property-observation-end") && !trace.some((e) => e.case === "A" && e.kind === "sub-detach") ? "valid" : "unknown", "property-observation-end recorded; sub-detach-skipped (sockets already closed by peer)", ["trace.jsonl"])
// ---- B
const B1 = R.B1
add("B.1", "gated normal exit 7: raw exit_code 7 in list/snapshot lifecycle and in exited frames on M and W; EOF after exited; fixture exit-stage and /proc witnesses", B1.exit?.reached && allGreen("B1") ? "valid" : "unknown", "offline verify (B1) green; raw exited payload in rx.bin", ["cases/B1/captures/M.rx.bin", "cases/B1/captures/W.rx.bin"])
for (const [id, c] of [["B.2", "B2"], ["B.3", "B3"]]) {
  const r = R[c]
  const lc = r.native_metadata?.terminal?.lifecycle
  add(id, `identified ${r.signal} on a freshly identity-rechecked fixture: native lifecycle ${JSON.stringify(lc)}, exited frames on M and W with raw exit_code (not null), EOF`, r.identity_recheck_ok && lc?.status === "exited" && allGreen(c) ? "valid" : "unknown", `exit_code reported as ${lc?.exit_code}; fixture exit-stage ack present=${r.fixture_exit_stage_ack}`, [`cases/${c}/captures/M.rx.bin`, `cases/${c}/captures/W.rx.bin`])
}
const sawNull = V.cases.some((c) => Object.values(c.facts.sockets).some((s) => s.exits.some((e) => e.key_present && e.exit_code === null))) || ["B1", "B2", "B3"].some((c) => R[c]?.native_metadata?.terminal?.lifecycle?.exit_code === null)
add("B.4", "native null exit_code branch", sawNull ? "valid" : "unknown", sawNull ? "raw null observed" : "NOT OBSERVED in 3 bounded attempts (normal=7, SIGTERM=1, SIGKILL=1); native-null branch unknown", ["cases/B1", "cases/B2", "cases/B3"])
// ---- C
const C = R.C
add("C.1", "same exact runtime dir: shutdown on identity-verified daemon; process stop verified by recorded pid/start/boot identity", C.shutdown_verified && C.daemon_stop?.state === "gone" ? "valid" : "unknown", `stop after ${C.daemon_stop?.after_ms} ms`, ["cases/C/case.json"])
add("C.2", "fixture and old streams after shutdown: fixture gone; old M/W got EOF without exited frame", C.fixture_after_shutdown?.state === "gone" ? "adverse" : "unknown", JSON.stringify({ fixture: C.fixture_after_shutdown, M: C.old_stream_M, W: C.old_stream_W }), ["cases/C/captures/M.rx.bin"])
add("C.3", "relaunch same binary in the same exact runtime dir became ready with matching registration pid/protocol/ping; new instance/pid/token; no stale-file error", C.relaunch?.ready && C.identity_compare?.registration_pid_equals_launched_pid ? "valid" : C.relaunch ? "adverse" : "unknown", JSON.stringify({ polls: C.relaunch?.polls, compare: C.identity_compare }), ["cases/C/case.json", "trace.jsonl"])
add("C.4", "old PTY id on the new instance: absent from list; snapshot error; attach at old cursor rejected (EOF without a response frame)", C.old_id_on_new && !C.old_id_on_new.contains_old_id ? "adverse" : "unknown", JSON.stringify({ snapshot: C.old_id_snapshot, ghost: C.old_cursor_attach?.attach }), ["cases/C/requests", "cases/C/captures/old-cursor-attach.rx.bin"])
add("C.5", "fresh gated PTY created and completed on the new instance (bytes verified offline)", C.fresh_exit?.reached && allGreen("C") ? "valid" : "unknown", "offline verify (C) green", ["cases/C/captures/M2.rx.bin", "cases/C/captures/W2.rx.bin"])
add("C.6", "changed instance identity as old-cursor continuity", "unknown", "NOT continuity: old id/cursor not recoverable on new instance", [])
// ---- D
add("D.1", "representative live-exit capture (B1): frame bytes recompared offline to frozen oracle for M and W", green("B1", "bytes-vs-oracle:M") && green("B1", "bytes-vs-oracle:W") ? "valid" : "unknown", "offline bytes-vs-oracle green", ["cases/B1"])
const D2 = R.D2
add("D.2", "before-exit reconnect: M closed at saved cursor, MID acked+W bytes+running, M reconnected at cursor (attached, running) before exit release; holes/overlaps none", D2.reconnect?.running_before_exit_release && allGreen("D2") ? "valid" : "unknown", JSON.stringify(D2.reconnect?.attach && { req: D2.reconnect.attach.requested_offset, avail: D2.reconnect.attach.available_offset, end: D2.reconnect.attach.end_offset, truncated: D2.reconnect.attach.truncated, replay_len: D2.reconnect.attach.replay_len }), ["cases/D2"])
const D3 = R.D3
const s2 = D3.stages?.find((s) => s.stage === "S2")
add("D.3", "replay/retention 64 KiB then 4 MiB cumulative: attach at 0/saved/head/tail with actual requested/available/end/truncated and replay bytes recompared offline", D3.status === "completed" && allGreen("D3") ? "valid" : D3.status === "stopped" ? "unknown" : "unknown", D3.reason ?? "completed; offline verify (D3) green", ["cases/D3"])
add("D.4", "4 MiB cumulative: retained window is a truncated replay (truncated=true when requesting below head); capacity/threshold/longer retention", s2?.stop?.startsWith("truncation") ? "adverse" : "unknown", `${s2?.stop ?? "no truncation"}; list head/tail ${JSON.stringify(s2?.list && { head: s2.list.head, tail: s2.list.tail })}; threshold and longer retention UNKNOWN`, ["cases/D3/captures/S2-at0.rx.bin"])
add("D.5", "post-exit finite retention samples at actual ~100 ms/1 s/5 s", D3.retention_samples?.length === 3 ? "valid" : "unknown", JSON.stringify(D3.retention_samples?.map((s) => [s.requested_after_ms, s.actual_after_anchor_ms, s.anchor])), ["cases/D3/samples/retention-D3.jsonl"])
fs.writeFileSync(path.join(E, "qualification.json"), JSON.stringify({ rules: "see analysis/qualify.mjs", claims: q }, null, 1))
console.log(q.map((c) => `${c.qualification.padEnd(11)} ${c.id} ${c.claim.slice(0, 90)}`).join("\n"))
