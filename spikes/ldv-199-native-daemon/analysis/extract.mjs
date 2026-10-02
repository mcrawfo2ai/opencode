// Derives a flat facts.json from an evidence directory (observations only). Usage: node extract.mjs <evidence-dir>
import fs from "node:fs"
import path from "node:path"
const dir = process.argv[2]
const J = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
const R = (n) => J(`case-${String(n).padStart(2, "0")}.json`)
const facts = {}
const T = (c, kind, pred = () => true) => c.trace.events.find((e) => e.kind === kind && pred(e))

// case 1
for (const s of R(1).result.subcases) {
  const p = `c1.exit${s.code}`
  facts[`${p}.list_lifecycle_at_100ms_1s_5s`] = s.samples.map((x) => JSON.stringify(x.terminal.lifecycle))
  facts[`${p}.snapshot_lifecycle`] = s.samples.map((x) => JSON.stringify(x.snapshot.terminal?.lifecycle))
  facts[`${p}.list_sent_after_anchor_ms`] = s.samples.map((x) => x.list_sent_after_anchor_ms)
  facts[`${p}.proc_gone_after_exit_stage_ms`] = s.procWitness.after_exit_stage_ms
  facts[`${p}.output_head_tail`] = s.samples.map((x) => `${x.terminal.head}/${x.terminal.tail}`)
  facts[`${p}.late_attach`] = `${s.late.attach.role}/gen${s.late.attach.generation}/req${s.late.attach.requested_offset}/avail${s.late.attach.available_offset}/end${s.late.attach.end_offset}/trunc${s.late.attach.truncated}/replay${s.late.attach.replay_len}`
  facts[`${p}.late_attach_terminal_lifecycle`] = JSON.stringify(s.late.attach.terminal.lifecycle)
  facts[`${p}.late_exited_frame`] = s.late.exit
  facts[`${p}.late_eof`] = s.late.eof
  facts[`${p}.late_bytes_match_oracle`] = s.late.compare.ok
  facts[`${p}.late_pre_origin_verified`] = s.late.compare.preOriginVerified
}
// case 2
{
  const r = R(2).result
  for (const [k, v] of Object.entries(r.subs)) {
    facts[`c2.${k}.attach`] = v.attach.failure ? `FAILED:${v.attach.failure}` : `${v.attach.role}/gen${v.attach.generation}/req${v.attach.requested_offset}/avail${v.attach.available_offset}/end${v.attach.end_offset}`
    facts[`c2.${k}.exit_frame`] = v.exit ? `code=${JSON.stringify(v.exit.exit_code_raw)} final_offset=${v.exit.final_offset}` : null
    facts[`c2.${k}.eof_after_exit`] = v.eof ? v.eof.afterExit : null
    facts[`c2.${k}.events`] = v.events.map((e) => (e.type === "controller_changed" ? `controller_changed(${e.attachment_id},gen${e.generation})` : e.type))
    facts[`c2.${k}.bytes_match_oracle`] = v.compare.ok ?? null
    facts[`c2.${k}.compared_bytes`] = v.compare.comparedBytes ?? null
  }
  facts["c2.control_op_by_observer"] = JSON.stringify(r.controlOp.resp)
  facts["c2.retained_after_exit"] = `${JSON.stringify(r.retainedAfterExit.terminal.lifecycle)} head/tail=${r.retainedAfterExit.terminal.head}/${r.retainedAfterExit.terminal.tail}`
  facts["c2.fresh_observer_after_exit"] = `${r.retainedAfterExit.freshObserver.attach.role}/gen${r.retainedAfterExit.freshObserver.attach.generation} exit_frame=${JSON.stringify(r.retainedAfterExit.freshObserver.exit)} bytes_ok=${r.retainedAfterExit.freshObserver.compare.ok}`
}
// case 3
{
  const r = R(3).result
  facts["c3.identity_violations"] = r.identityViolations.length
  facts["c3.frames_bound"] = r.identityFramesChecked
  facts["c3.foreign_markers_seen"] = Object.fromEntries(Object.entries(r.subs).map(([k, v]) => [k, v.foreignMarkersSeen]))
  facts["c3.bytes_match_oracle"] = Object.fromEntries(Object.entries(r.subs).map(([k, v]) => [k, v.compare.ok]))
  facts["c3.A2_stayed_gated_while_A1_B1_ran"] = `${!r.A2gatedWindow.A2_started_ack && r.A2gatedWindow.A2_sub_maxEnd_before === r.A2gatedWindow.after} (witness A1/B1 started=${r.A2gatedWindow.witness.A1_started && r.A2gatedWindow.witness.B1_started})`
  facts["c3.A2_arbitration_events"] = r.arbitration.A2.first.map((e) => (e.type === "controller_changed" ? `controller_changed(${e.attachment_id},gen${e.generation})` : e.type))
  facts["c3.A2_running_after_A1B1_exit"] = JSON.stringify(r.A2_after_A1B1_exit.lifecycle)
}
// case 4
{
  const r = R(4).result
  facts["c4.foreground_samples_while_child_running"] = [...new Set(r.childRunning.foregroundSamples.map((x) => x.fg))]
  facts["c4.child_exit_code_independent"] = `${r.childExit.fixtureAck.extra.code} (file ${r.childExit.childCodeFile})`
  facts["c4.window_after_child_exit"] = { lifecycles: [...new Set(r.afterChildExitWindow.map((x) => JSON.stringify(x.lifecycle)))], fg: [...new Set(r.afterChildExitWindow.map((x) => x.fg))], shell_proc: [...new Set(r.afterChildExitWindow.map((x) => x.shell_proc.split(":")[0]))], child_proc: [...new Set(r.afterChildExitWindow.map((x) => x.child_proc))], exit_event_seen: r.afterChildExitWindow.some((x) => x.obs_exit_event) }
  facts["c4.observer_events"] = r.observerEvents.events.map((e) => (e.type === "foreground_process_changed" ? `fg->${e.process}` : e.type === "exited" ? `exited(code=${JSON.stringify(e.exit_code)},final=${e.final_offset})` : e.type))
  facts["c4.final_native_lifecycle"] = JSON.stringify(r.exit.listExited.terminal.lifecycle)
  facts["c4.bytes_match_oracle"] = r.observerCompare.ok
  facts["c4.mode_echo_opost_off"] = `${r.modeAfterHasEchoOff}/${r.modeAfterHasOpostOff}`
}
// case 5
{
  const r = R(5).result
  facts["c5.sizes"] = r.sizes.map((s) => ({ size: s.size, head: s.native.terminal.head, tail: s.native.terminal.tail, attaches: s.subs.map((x) => (x.sameCursorAs ? `${x.at}=same as ${x.sameCursorAs}` : `${x.at}@${x.cursor}:avail${x.attach.available_offset}/end${x.attach.end_offset}/trunc${x.attach.truncated}/replay${x.attach.replay_len}/ok=${x.compare.ok ?? "n/a"}`)), prior_tail_live: s.priorTailSubscriber ? `frames=${s.priorTailSubscriber.frames},ok=${s.priorTailSubscriber.compare.ok},holes=${s.priorTailSubscriber.compare.coverage.holes.length},overlaps=${s.priorTailSubscriber.compare.coverage.overlaps.length}` : null, stop: s.stoppedHere }))
  facts["c5.unreached"] = r.unreached
  facts["c5.capacity_statement"] = r.capacityUnknownReason
}
// cases 6 / 7
{
  const r = R(6).result
  facts["c6.saved_cursor"] = r.savedCursor
  facts["c6.reconnect_attach"] = `req${r.reconnect.attach.requested_offset}/avail${r.reconnect.attach.available_offset}/end${r.reconnect.attach.end_offset}/trunc${r.reconnect.attach.truncated}/replay${r.reconnect.attach.replay_len}/gen${r.reconnect.attach.generation}/role${r.reconnect.attach.role}`
  facts["c6.holes_overlaps_M1+M2"] = `${r.hole_overlap_M1_plus_M2.holes.length}/${r.hole_overlap_M1_plus_M2.overlaps.length}`
  facts["c6.bytes_ok"] = Object.fromEntries(Object.entries(r.compare).map(([k, v]) => [k, v.ok]))
  facts["c6.exit_frames"] = Object.fromEntries(Object.entries(r.exit.subs).map(([k, v]) => [k, v.exit && `code=${JSON.stringify(v.exit.exit_code_raw)} final=${v.exit.final_offset}`]))
  const r7 = R(7).result
  facts["c7.exit_confirmed_independently"] = r7.exitConfirmedIndependently
  facts["c7.reconnect_attach"] = `req${r7.reconnect.attach.requested_offset}/end${r7.reconnect.attach.end_offset}/trunc${r7.reconnect.attach.truncated}/replay${r7.reconnect.attach.replay_len}/lifecycle=${JSON.stringify(r7.reconnect.attach.terminal.lifecycle)}`
  facts["c7.reconnect_exit_frame"] = r7.reconnect.exit
  facts["c7.reconnect_eof"] = r7.reconnect.eof
  facts["c7.joined_bytes_ok_and_holes"] = `${r7.joined.M1_then_M2.ok}/${r7.joined.coverage.holes.length}/${r7.joined.coverage.overlaps.length}`
  facts["c7.witness_exit"] = JSON.stringify(r7.W.exit)
}
// case 8
{
  const c = R(8)
  const r = c.result
  facts["c8.terminate_response"] = JSON.stringify(r.terminate.resp)
  facts["c8.fixture_proc_after_response"] = r.procAtResponse
  facts["c8.proc_gone_after_response_ms"] = r.procWitness.after_terminate_response_ms
  facts["c8.exited_frames"] = { M: r.subs.M.exit, W: r.subs.W.exit }
  facts["c8.eof"] = { M: !!r.subs.M.eof, W: !!r.subs.W.eof }
  facts["c8.list_present_after"] = r.after.listPresent
  facts["c8.snapshot_after"] = JSON.stringify(r.after.snapshot)
  facts["c8.attach_after"] = JSON.stringify(r.after.attachAfter)
  facts["c8.fixture_saw_signal"] = r.after.signalsLog
  facts["c8.fixture_exit_stage_reached"] = r.after.fixtureExitStageAck
}
// case 9
{
  const r = R(9).result
  facts["c9.prepare"] = `${r.prepare.resp.type} expires_in_ms~${r.prepare.expires_in_ms}`
  facts["c9.claim_while_old_owner_open"] = JSON.stringify(r.claimWhileOldOwnerOpen)
  facts["c9.same_instance_before_old_close"] = r.sameInstanceBeforeOldOwnerClose.pong_matches
  facts["c9.after_old_owner_close(variant B)"] = { daemon: r.afterOldOwnerClose.daemon, fixture: r.afterOldOwnerClose.fixture, S1_eof: !!r.afterOldOwnerClose.S1.eof, S2_eof: !!r.afterOldOwnerClose.S2.eof }
  facts["c9.claim_after_old_owner_close(variant B)"] = JSON.stringify(r.claimAfterOldOwnerClose)
  facts["c9.same_instance_after_claim"] = `${r.sameInstanceAfterClaim.pong_matches} token_unchanged=${r.sameInstanceAfterClaim.registration_token_unchanged}`
  facts["c9.old_streams_survived_and_exit"] = Object.fromEntries(Object.entries(r.subs).map(([k, v]) => [k, `bytes_ok=${v.compare.ok} exit=${v.exit && `code=${v.exit.exit_code_raw} final=${v.exit.final_offset}`} eof=${!!v.eof}`]))
}
// case 10
{
  const r = R(10).result
  facts["c10.shutdown_response"] = JSON.stringify(r.shutdown.resp)
  facts["c10.daemon_stop_proof"] = `proc=${r.stopProof.daemon_proc_state} after_ms=${r.stopProof.after_ms} exit=${JSON.stringify(r.stopProof.daemon_exit_event && { code: r.stopProof.daemon_exit_event.code, signal: r.stopProof.daemon_exit_event.signal })} ping_old=${r.stopProof.ping_old.failure}/${r.stopProof.ping_old.code}`
  facts["c10.fixture_after_shutdown"] = r.afterShutdown.fixture_proc
  facts["c10.old_stream_after_shutdown"] = `eof=${!!r.afterShutdown.S1.eof} close=${!!r.afterShutdown.S1.close} exited_frame=${JSON.stringify(r.afterShutdown.S1.exit)}`
  facts["c10.identity_changed"] = JSON.stringify(r.new.identity_changed)
  facts["c10.old_id_present_on_new_list"] = r.oldIdOnNew.contains_old_id
  facts["c10.old_id_old_cursor_attach_on_new"] = JSON.stringify(r.oldCursorOnNew.attach)
  facts["c10.fresh_fixture"] = `bytes_ok=${r.freshCompare.compare.ok} exit=${JSON.stringify(r.freshCompare.exit)}`
}
// case 11
{
  const r = R(11).result
  facts["c11.roles"] = JSON.stringify(r.roles)
  facts["c11.local_detach"] = `closed_local=${r.detach.local_close?.local} destroyed=${r.detach.socket_destroyed} repeated_detach_threw=${r.detach.repeated_detach_threw}`
  facts["c11.callbacks_after_detach"] = `frames_after=${r.window.M_events_after_detach} frames_during_window=${r.window.M_frames_during_window}`
  facts["c11.stimulus_witness_saw_mid"] = `${r.window.stimulus_witness.W_maxEnd}>=${r.window.stimulus_witness.expected_mid_tail}`
  facts["c11.witness_events_since_detach"] = r.window.W_events_since_detach.map((e) => `${e.type}(${e.attachment_id},gen${e.generation})`)
  facts["c11.reattach_same_attachment_id"] = `${r.reattachSameAttachmentID.type}/${r.reattachSameAttachmentID.role}/gen${r.reattachSameAttachmentID.generation}`
}
// case 12
{
  const c = R(12)
  const r = c.result
  const oc = c.trace.events.find((e) => e.kind === "owner-close")
  const dx = c.trace.events.find((e) => e.kind === "daemon-exit-event")
  const subEof = Object.fromEntries(c.trace.events.filter((x) => x.kind === "sub-conn" && x.conn_event === "eof" && x.sub?.startsWith("c12-sub")).map((x) => [x.sub, oc ? Math.round((x.t_ms - oc.t_ms) * 10) / 10 : null]))
  facts["c12.before_owner_close"] = JSON.stringify(r.ownerClose.before)
  facts["c12.start_observed_by_both"] = r.start.ok
  facts["c12.after_1500ms"] = { daemon: r.ownerClose.after_1500ms.daemon, fixture: r.ownerClose.after_1500ms.fixture, daemon_exit: r.ownerClose.after_1500ms.daemon_exit_event && { code: r.ownerClose.after_1500ms.daemon_exit_event.code, signal: r.ownerClose.after_1500ms.daemon_exit_event.signal }, S1_eof: !!r.ownerClose.after_1500ms.S1.eof, S2_eof: !!r.ownerClose.after_1500ms.S2.eof, S1_exited_frame: r.ownerClose.after_1500ms.S1.exit, S2_exited_frame: r.ownerClose.after_1500ms.S2.exit }
  facts["c12.owner_close_to_daemon_exit_ms"] = oc && dx ? Math.round((dx.t_ms - oc.t_ms) * 10) / 10 : null
  facts["c12.sub_eof_after_owner_close_ms"] = subEof
  facts["c12.ping_after"] = JSON.stringify(r.ownerClose.pingAfter)
  facts["c12.service_registration_after"] = JSON.stringify(r.ownerClose.registrationAfter)
  facts["c12.mid_after_close"] = r.mid.fixtureAck ? "fixture acked" : "NOT reached: fixture produced no mid ack (fixture dead)"
  facts["c12.exit_observation"] = r.exit.notReached ?? r.exit
  facts["c12.order_violations"] = r.case12OrderViolations.length
}
// case 13
{
  const r = R(13).result
  facts["c13.native_lifecycle_after_external_sigkill"] = JSON.stringify(r.list.lifecycle_raw)
  facts["c13.witness_exited_frame"] = JSON.stringify(r.witness.exit)
  facts["c13.proc_witness"] = r.procWitness.state
}
// instrument
{
  const ms = J("matrix.json").matrix
  facts["matrix.status"] = Object.fromEntries(ms.map((m) => [m.id, m.status]))
  const cr = J("controls-real.json"), cs = J("controls-synthetic.json")
  facts["controls.synthetic_pass"] = `${cs.results.filter((x) => x.pass).length}/${cs.results.length}`
  facts["controls.native_captured_pass"] = `${cr.results.filter((x) => x.pass).length}/${cr.results.length}`
  const ord = ms.flatMap((m) => m.signals.filter((s) => s.signal === "ordering-violation").map((s) => ({ case: m.id, detail: s.detail })))
  facts["ordering_violations_all_cases"] = ord
  const cmpFail = ms.flatMap((m) => m.signals.filter((s) => s.signal === "compare-mismatch").map((s) => ({ case: m.id, path: s.path })))
  facts["byte_compare_mismatches_all_cases"] = cmpFail
  facts["timed_out_signals"] = ms.flatMap((m) => m.signals.filter((s) => s.signal === "timed-out").map((s) => ({ case: m.id, path: s.path })))
  facts["failure_signals"] = ms.flatMap((m) => m.signals.filter((s) => s.signal.startsWith("failure")).map((s) => ({ case: m.id, path: s.path, signal: s.signal })))
}
fs.writeFileSync(path.join(dir, "facts.json"), JSON.stringify(facts, null, 1))
console.log(path.join(dir, "facts.json"), Object.keys(facts).length, "facts")
