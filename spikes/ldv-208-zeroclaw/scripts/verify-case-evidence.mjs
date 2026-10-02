// Offline evidence checker for the core case (create -> prompt persisted -> stream -> tool -> completion -> reconnect).
// Oracle = stub provider's independently written log (stub-oracle-core.json); never the shim's own labels.
import fs from "node:fs"
import path from "node:path"
const readJson = (d, f) => JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))
const readJsonl = (d, f) => fs.readFileSync(path.join(d, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
export function checkCase(dir) {
  const errs = []; const res = readJson(dir, "case-results.json"); const oracle = readJson(dir, "stub-oracle-core.json")
  const sse = readJsonl(dir, "shim-sse-frames-first.jsonl"); const nativeMsgs = readJson(dir, "native-messages-final.json"); const natList = readJson(dir, "native-session-list.json")
  const { SID, NID, marker } = res.core
  // oracle marker: independent, from the stub's own received-request log
  const req1 = oracle.find((r) => r.kind === "request_received" && r.phase === 1)
  if (!req1 || req1.marker !== marker) errs.push(`MARKER_MISMATCH oracle=${req1?.marker} observed=${marker}`)
  if (!sse.some((f) => JSON.stringify(f.json ?? "").includes(req1?.marker ?? "∅"))) errs.push("MARKER_NOT_IN_STREAM")
  if (!(nativeMsgs.messages ?? nativeMsgs).some?.((m) => m.role === "assistant" && String(m.content).includes("FINAL " + (req1?.marker ?? "∅")))) errs.push("MARKER_NOT_IN_PERSISTED_FINAL")
  // session identity: every event's sessionID == created id; native store lists the mapped native id
  const sids = new Set(sse.filter((f) => f.json?.properties?.sessionID).map((f) => f.json.properties.sessionID))
  if (sids.size !== 1 || !sids.has(SID)) errs.push(`SESSION_ID_MISMATCH events=${[...sids].join(",")} created=${SID}`)
  const listed = JSON.stringify(natList)
  if (!listed.includes(NID)) errs.push(`NATIVE_SESSION_NOT_LISTED ${NID}`)
  // tool result vs fixture + oracle tool-result log
  const fx = res.cases.stream.fixtureText
  const req2 = oracle.find((r) => r.kind === "request_received" && r.phase === 2)
  if (!req2 || !String(req2.last_tool_content_head).includes(fx)) errs.push("TOOL_RESULT_NOT_FIXTURE_IN_ORACLE")
  const toolOut = res.cases.stream.toolDone?.properties?.part?.state?.output
  if (!String(toolOut ?? "").includes(fx)) errs.push("TOOL_RESULT_NOT_FIXTURE_IN_STREAM")
  // ordering from driver timeline (monotonic)
  const tl = res.timeline; const idx = (k, pred = () => true) => tl.findIndex((r) => r.kind === k && pred(r))
  const order = [idx("prompt_persistence_probe"), idx("streams_attached"), idx("stub_g1_released"), idx("marker_observed", (r) => r.observed), idx("stub_g2_released"), idx("tool_events", (r) => r.call && r.result), idx("stub_g3_released"), idx("completion_event_observed", (r) => r.observed), idx("completion_persisted_probe", (r) => r.persisted), idx("subscribers_closed"), idx("reconnect_established")]
  const names = ["prompt_persisted", "streams_attached", "g1", "marker", "g2", "tool", "g3", "completion_event", "completion_persisted", "subscribers_closed", "reconnect"]
  order.forEach((i, k) => { if (i < 0) errs.push(`ORDER_MISSING ${names[k]}`) })
  for (let k = 1; k < order.length; k++) if (order[k] >= 0 && order[k - 1] >= 0 && !(tl[order[k]].mono_ms >= tl[order[k - 1]].mono_ms && order[k] > order[k - 1])) errs.push(`ORDER_VIOLATION ${names[k - 1]} !< ${names[k]}`)
  return errs
}
if (import.meta.main) { const errs = checkCase(process.argv[2]); console.log(JSON.stringify({ ok: errs.length === 0, errors: errs })); process.exit(errs.length ? 1 : 0) }
