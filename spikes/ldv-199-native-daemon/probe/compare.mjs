// LDV-199 comparators and ordering/identity/exit-code checks. Pure functions so negative controls can
// exercise them offline. They only report what they find; they carry no expected-result labels.
import { createHash } from "node:crypto"

const h = (b) => createHash("sha256").update(b).digest("hex")

// intervals: [{start,end,data:Buffer}] native [start,end). oracle: bytes emitted after `origin`.
// Native offset N maps to oracle[N-origin]. Bytes before origin or beyond the oracle are counted, not compared.
export function compareToOracle({ intervals, oracle, origin }) {
  const res = {
    intervals: intervals.length,
    comparedBytes: 0,
    preOriginBytes: 0,
    beyondOracleBytes: 0,
    boundsProblems: [],
    firstDifference: null,
    nativeSha256: null,
    oracleSha256: null,
  }
  const nat = createHash("sha256")
  const ora = createHash("sha256")
  for (const iv of intervals) {
    if (iv.data.length !== iv.end - iv.start) {
      res.boundsProblems.push({ start: iv.start, end: iv.end, dataLength: iv.data.length })
      continue
    }
    let lo = iv.start - origin
    let skipHead = 0
    if (lo < 0) {
      skipHead = -lo
      res.preOriginBytes += Math.min(skipHead, iv.data.length)
      lo = 0
    }
    if (skipHead >= iv.data.length) continue
    let data = iv.data.subarray(skipHead)
    if (lo + data.length > oracle.length) {
      const extra = lo + data.length - oracle.length
      res.beyondOracleBytes += Math.min(extra, data.length)
      data = data.subarray(0, Math.max(0, oracle.length - lo))
    }
    const expect = oracle.subarray(lo, lo + data.length)
    nat.update(data)
    ora.update(expect)
    res.comparedBytes += data.length
    if (!res.firstDifference && Buffer.compare(data, expect) !== 0) {
      let i = 0
      while (i < data.length && data[i] === expect[i]) i++
      res.firstDifference = {
        nativeOffset: iv.start + skipHead + i,
        oracleIndex: lo + i,
        nativeByte: data[i],
        oracleByte: expect[i],
        intervalStart: iv.start,
        intervalEnd: iv.end,
      }
    }
  }
  res.nativeSha256 = nat.digest("hex")
  res.oracleSha256 = ora.digest("hex")
  res.ok = res.boundsProblems.length === 0 && !res.firstDifference
  return res
}

// Holes/overlaps of intervals over [from,to).
export function coverage(intervals, from, to) {
  const sorted = [...intervals].map((i) => [i.start, i.end]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const holes = []
  const overlaps = []
  let pos = from
  for (const [s, e] of sorted) {
    if (e <= from || s >= to) continue
    if (s > pos) holes.push([pos, Math.min(s, to)])
    if (s < pos) overlaps.push([Math.max(s, from), Math.min(pos, e)])
    pos = Math.max(pos, e)
  }
  if (pos < to) holes.push([pos, to])
  return { from, to, holes, overlaps, covered: holes.length === 0 }
}

// events: [{kind:'ack'|'native-running'|'gate-release', fx, name?}] in recorded order.
// Rule: an exit gate release needs (intermediate ack) then (native-running) then the release, in that order, per fixture.
export function checkOrdering(events) {
  const violations = []
  const by = new Map()
  events.forEach((ev, idx) => {
    if (ev.kind === "gate-release" && ev.name !== "exit" && ev.name !== "outer") return
    const st = by.get(ev.fx) ?? { ack: -1, running: -1 }
    by.set(ev.fx, st)
    if (ev.kind === "ack" && (ev.name === "mid-emitted" || ev.name === "alive")) st.ack = idx
    if (ev.kind === "native-running" && st.ack >= 0 && idx > st.ack) st.running = idx
    if (ev.kind === "gate-release") {
      if (st.ack < 0) violations.push({ fx: ev.fx, at: idx, problem: "exit gate released without intermediate acknowledgment" })
      else if (st.running < 0)
        violations.push({ fx: ev.fx, at: idx, problem: "exit gate released without native-running observation after intermediate ack" })
    }
  })
  return violations
}

// Case-12 ordering: owner closed with subscribers active, none detached/lost/removed/handed-off before the property is
// observed (property-observed or property-timeout after owner-close).
export function checkCase12(events) {
  const violations = []
  const closeIdx = events.findIndex((e) => e.kind === "owner-close")
  if (closeIdx < 0) return [{ problem: "owner-close not recorded" }]
  const started = new Set(events.slice(0, closeIdx).filter((e) => e.kind === "sub-start-observed").map((e) => e.sub))
  if (started.size < 2) violations.push({ problem: `fewer than 2 subscribers had start observed before owner-close (${started.size})` })
  const settle = events.findIndex((e, i) => i > closeIdx && (e.kind === "property-observed" || e.kind === "property-timeout"))
  const gone = new Set(["sub-detach", "sub-lost", "sub-removed", "handoff"])
  events.forEach((e, i) => {
    if (!gone.has(e.kind)) return
    if (i < closeIdx) violations.push({ at: i, sub: e.sub, problem: `${e.kind} before owner-close` })
    else if (settle < 0 || i < settle) violations.push({ at: i, sub: e.sub, problem: `${e.kind} before property observed/timed out` })
  })
  return violations
}

// frames: [{socket, instance_id, pty_id, group_id}], expectBySocket: {label:{instance_id,pty_id,group_id}}
export function checkIdentity(frames, expectBySocket) {
  const v = []
  frames.forEach((f, i) => {
    const want = expectBySocket[f.socket]
    if (!want) return v.push({ at: i, socket: f.socket, problem: "no expectation for socket" })
    for (const k of ["instance_id", "pty_id", "group_id"])
      if (f[k] !== want[k]) v.push({ at: i, socket: f.socket, field: k, got: f[k], want: want[k] })
  })
  return v
}

// records: [{raw, recorded}] where raw is the exit_code as received (null/number) and recorded is what the trace kept.
export function checkExitCodes(records) {
  const v = []
  records.forEach((r, i) => {
    if (r.raw !== r.recorded) v.push({ at: i, raw: r.raw, recorded: r.recorded, problem: "recorded exit_code differs from raw" })
  })
  return v
}

export { h as sha256hex }
