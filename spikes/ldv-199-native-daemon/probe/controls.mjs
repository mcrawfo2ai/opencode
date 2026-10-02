// LDV-199 offline negative controls. Each control: baseline green -> mutate a CLONE -> must go red with the exact
// changed value/position reported -> restore (fresh clone) -> green again. Synthetic data here; the same mutators are
// re-applied to captured native data by run.mjs after the matrix (see runRealControls).
import { createHash } from "node:crypto"
import { compareToOracle, checkOrdering, checkCase12, checkIdentity, checkExitCodes } from "./compare.mjs"

const clone = (v) => structuredClone(v)

export function syntheticInputs() {
  const origin = 112
  const recs = []
  for (let i = 0; i < 64; i++) recs.push(Buffer.from(`R${String(i).padStart(10, "0")}|${createHash("sha256").update(String(i)).digest("hex").slice(0, 51)}\n`))
  const oracle = Buffer.concat(recs)
  const intervals = []
  for (let off = 0; off < oracle.length; off += 640) {
    const end = Math.min(off + 640, oracle.length)
    intervals.push({ start: origin + off, end: origin + end, data: Buffer.from(oracle.subarray(off, end)) })
  }
  const order = [
    { kind: "ack", fx: "F", name: "mid-emitted" },
    { kind: "native-running", fx: "F" },
    { kind: "gate-release", fx: "F", name: "exit" },
  ]
  const case12 = [
    { kind: "sub-start-observed", sub: "S1" },
    { kind: "sub-start-observed", sub: "S2" },
    { kind: "owner-close" },
    { kind: "property-observed" },
    { kind: "sub-detach", sub: "S1" },
  ]
  const frames = [
    { socket: "s1", instance_id: "I1", pty_id: 11, group_id: "gA" },
    { socket: "s2", instance_id: "I1", pty_id: 12, group_id: "gB" },
  ]
  const expectBySocket = { s1: { instance_id: "I1", pty_id: 11, group_id: "gA" }, s2: { instance_id: "I1", pty_id: 12, group_id: "gB" } }
  const exits = [{ raw: null, recorded: null }, { raw: 7, recorded: 7 }]
  return { origin, oracle, intervals, order, case12, frames, expectBySocket, exits }
}

export function runControls(inp, tag) {
  const results = []
  const rec = (name, mutation, baseline, mutated, restored, detectedOk, detail) =>
    results.push({ tag, name, mutation, baseline_green: baseline, mutated_red: mutated, restored_green: restored, detected_expected_change: detectedOk, detail, pass: baseline && mutated && restored && detectedOk })
  const cmp = (iv, oracle = inp.oracle) => compareToOracle({ intervals: iv, oracle, origin: inp.origin })

  // 1. change one observed byte, oracle unchanged
  {
    const base = cmp(inp.intervals)
    const mut = clone(inp.intervals).map((i) => ({ ...i, data: Buffer.from(i.data) }))
    const k = Math.min(1, mut.length - 1)
    const idx = Math.min(5, mut[k].data.length - 1)
    const orig = mut[k].data[idx]
    mut[k].data[idx] = orig ^ 0xff
    const r = cmp(mut)
    const expectOffset = mut[k].start + idx
    const restored = cmp(inp.intervals)
    rec("observed-byte-changed", `interval#${k} byte index ${idx} ${orig}->${orig ^ 0xff}`, base.ok, !r.ok, restored.ok, r.firstDifference?.nativeOffset === expectOffset && r.firstDifference.nativeByte === (orig ^ 0xff) && r.firstDifference.oracleByte === orig, { expectedOffset: expectOffset, reported: r.firstDifference })
  }
  // 2. change an observed offset (shift interval), data and oracle unchanged
  {
    const base = cmp(inp.intervals)
    const mut = inp.intervals.map((i) => ({ ...i, data: Buffer.from(i.data) }))
    const k = Math.min(1, mut.length - 1)
    mut[k].start += 1
    mut[k].end += 1
    const r = cmp(mut)
    const restored = cmp(inp.intervals)
    rec("observed-offset-shifted", `interval#${k} start/end +1`, base.ok, !r.ok, restored.ok, !!r.firstDifference && r.firstDifference.intervalStart === mut[k].start && r.firstDifference.nativeOffset >= mut[k].start, { reported: r.firstDifference })
  }
  // 2b. interval length no longer equals end-start
  {
    const mut = inp.intervals.map((i) => ({ ...i }))
    mut[0] = { ...mut[0], end: mut[0].end + 3 }
    const r = cmp(mut)
    rec("interval-bounds-inconsistent", "interval#0 end +3 without data", cmp(inp.intervals).ok, !r.ok, cmp(inp.intervals).ok, r.boundsProblems.length === 1 && r.boundsProblems[0].start === mut[0].start, { reported: r.boundsProblems })
  }
  // 3. omit intermediate acknowledgment / release exit early
  {
    const base = checkOrdering(inp.order)
    const noAck = clone(inp.order).filter((e) => e.kind !== "ack")
    const r1 = checkOrdering(noAck)
    const early = clone(inp.order)
    ;[early[1], early[2]] = [early[2], early[1]] // release before native-running
    const r2 = checkOrdering(early)
    const restored = checkOrdering(clone(inp.order))
    rec("intermediate-ack-omitted", "dropped ack event", base.length === 0, r1.length === 1, restored.length === 0, r1[0]?.problem === "exit gate released without intermediate acknowledgment", { reported: r1 })
    rec("exit-released-before-native-running", "swapped native-running and gate-release", base.length === 0, r2.length === 1, restored.length === 0, r2[0]?.problem === "exit gate released without native-running observation after intermediate ack", { reported: r2 })
  }
  // 4. detach before active-owner-close (and before property observed)
  {
    const base = checkCase12(inp.case12)
    const mut = clone(inp.case12)
    const detach = mut.pop()
    mut.splice(2, 0, detach) // before owner-close
    const r = checkCase12(mut)
    const mut2 = clone(inp.case12)
    const d2 = mut2.pop()
    mut2.splice(3, 0, d2) // after close, before property observed
    const r2 = checkCase12(mut2)
    const restored = checkCase12(clone(inp.case12))
    rec("detach-before-owner-close", "moved sub-detach before owner-close", base.length === 0, r.some((v) => v.problem === "sub-detach before owner-close"), restored.length === 0, r.some((v) => v.problem === "sub-detach before owner-close" && v.sub === detach.sub), { reported: r })
    rec("detach-before-property-settled", "moved sub-detach after owner-close but before property-observed", base.length === 0, r2.some((v) => v.problem === "sub-detach before property observed/timed out"), restored.length === 0, r2.length === 1, { reported: r2 })
  }
  // 5. substitute instance identity
  {
    const base = checkIdentity(inp.frames, inp.expectBySocket)
    const mut = clone(inp.frames)
    const wasInstance = mut[1].instance_id
    mut[1].instance_id = "I-substituted"
    const r = checkIdentity(mut, inp.expectBySocket)
    const restored = checkIdentity(clone(inp.frames), inp.expectBySocket)
    rec("instance-identity-substituted", `frame#1 instance_id ${wasInstance}->I-substituted`, base.length === 0, r.length === 1, restored.length === 0, r[0]?.field === "instance_id" && r[0].got === "I-substituted" && r[0].want === wasInstance && r[0].at === 1, { reported: r })
  }
  // 6. replace a raw exit code with zero; targets a raw null if the data has one, else the first non-zero code
  {
    const base = checkExitCodes(inp.exits)
    const mut = clone(inp.exits)
    let idx = mut.findIndex((e) => e.raw === null)
    const rawWasNull = idx >= 0
    if (idx < 0) idx = mut.findIndex((e) => e.raw !== 0)
    if (idx < 0) idx = 0
    const rawBefore = mut[idx].raw
    mut[idx].recorded = 0
    const r = checkExitCodes(mut)
    const restored = checkExitCodes(clone(inp.exits))
    rec("raw-exit-code-replaced-by-zero", `recorded exit_code ${JSON.stringify(rawBefore)}->0 (raw_was_null=${rawWasNull})`, base.length === 0, r.length === 1, restored.length === 0, r[0]?.raw === rawBefore && r[0].recorded === 0 && r[0].at === idx, { raw_was_null: rawWasNull, reported: r })
  }
  return results
}
