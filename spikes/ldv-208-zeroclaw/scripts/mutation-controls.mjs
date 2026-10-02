// Offline red/green controls: prove the checks can fail, for the intended reason, on throwaway COPIES only.
// Usage: bun mutation-controls.mjs <data-dir> <evidence-dir> <out.json>
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import { checkCoverage } from "./verify-coverage.mjs"
import { checkCase } from "./verify-case-evidence.mjs"
const [DATA, EVD, OUT] = process.argv.slice(2)
const h = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ldv208-mut-"))
const copyEvidence = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d); for (const f of fs.readdirSync(EVD)) if (fs.statSync(path.join(EVD, f)).isFile()) fs.copyFileSync(path.join(EVD, f), path.join(d, f)); return d }
const rows = []
const run = (name, fn) => { const r = fn(); rows.push({ name, ...r }) }
const j = (p) => JSON.parse(fs.readFileSync(p, "utf8"))
const inv = j(path.join(DATA, "brief-inventory.json")), ext = j(path.join(DATA, "extracted-contract.json")), rep = j(path.join(DATA, "extraction-report.json"))

// green baselines
const greenCov = checkCoverage(inv, ext, rep); const greenCase = checkCase(EVD)
rows.push({ name: "baseline-green-coverage", expectErrors: [], gotErrors: greenCov, pass: greenCov.length === 0 })
rows.push({ name: "baseline-green-case", expectErrors: [], gotErrors: greenCase, pass: greenCase.length === 0 })

// M1: remove one required inventory route from a COPY of the extracted evidence
run("M1-remove-inventory-route", () => {
  const m = structuredClone(ext); const before = m.operations.length
  m.operations = m.operations.filter((o) => !(o.method === "post" && o.path === "/session/{sessionID}/abort"))
  const landed = before - m.operations.length === 1
  const errs = checkCoverage(inv, m, rep)
  return { mutationLanded: landed, expectErrors: ["MISSING_ROUTE POST /session/{sessionID}/abort"], gotErrors: errs, pass: landed && errs.includes("MISSING_ROUTE POST /session/{sessionID}/abort") && errs.length === 1 }
})

// M2a: change observed session ID (stream copy) while stub oracle stays fixed
run("M2a-change-observed-session-id", () => {
  const d = copyEvidence("m2a"); const f = path.join(d, "shim-sse-frames-first.jsonl"); const before = fs.readFileSync(f, "utf8"); const SID = j(path.join(d, "case-results.json")).core.SID
  let n = 0; const after = before.split(SID).join((() => { n++; return SID.slice(0, -2) + "zz" })())
  const landed = after !== before && h(f) !== crypto.createHash("sha256").update(after).digest("hex"); fs.writeFileSync(f, after)
  const errs = checkCase(d)
  return { mutationLanded: landed, expectErrors: ["SESSION_ID_MISMATCH"], gotErrors: errs, pass: landed && errs.some((e) => e.startsWith("SESSION_ID_MISMATCH")) }
})
// M2b: change observed marker (stream + results copy) while oracle stays fixed
run("M2b-change-observed-marker", () => {
  const d = copyEvidence("m2b"); const rp = path.join(d, "case-results.json"); const res = j(rp); const old = res.core.marker; const bad = old.slice(0, -2) + "00"
  const f = path.join(d, "shim-sse-frames-first.jsonl"); const sBefore = fs.readFileSync(f, "utf8")
  res.core.marker = bad; fs.writeFileSync(rp, JSON.stringify(res)); fs.writeFileSync(f, sBefore.split(old).join(bad))
  const landed = fs.readFileSync(f, "utf8") !== sBefore && j(rp).core.marker === bad
  const errs = checkCase(d)
  return { mutationLanded: landed, expectErrors: ["MARKER_MISMATCH"], gotErrors: errs, pass: landed && errs.some((e) => e.startsWith("MARKER_MISMATCH")) }
})
// M3: move reconnect before completion (timeline copy)
run("M3-reconnect-before-completion", () => {
  const d = copyEvidence("m3"); const rp = path.join(d, "case-results.json"); const res = j(rp); const tl = res.timeline
  const i = tl.findIndex((r) => r.kind === "subscribers_closed"); const k = tl.findIndex((r) => r.kind === "reconnect_established"); const g3 = tl.findIndex((r) => r.kind === "stub_g3_released")
  const moved = tl.splice(i, k - i + 1); tl.splice(g3, 0, ...moved) // reconnect now occurs before g3 release/completion
  const t0 = tl[g3 - 1].mono_ms; moved.forEach((r, n) => (r.mono_ms = t0 + 0.001 * (n + 1)))
  fs.writeFileSync(rp, JSON.stringify(res)); const landed = res.timeline.findIndex((r) => r.kind === "reconnect_established") < res.timeline.findIndex((r) => r.kind === "completion_persisted_probe")
  const errs = checkCase(d)
  return { mutationLanded: landed, expectErrors: ["ORDER_VIOLATION"], gotErrors: errs, pass: landed && errs.some((e) => e.startsWith("ORDER_VIOLATION")) }
})
// restore + require green: originals untouched; re-run baselines after mutations
const afterCov = checkCoverage(inv, ext, rep), afterCase = checkCase(EVD)
rows.push({ name: "restored-green-after-mutations", gotErrors: [...afterCov, ...afterCase], pass: afterCov.length === 0 && afterCase.length === 0, originals_sha256: { "extracted-contract.json": h(path.join(DATA, "extracted-contract.json")), "case-results.json": h(path.join(EVD, "case-results.json")) } })
fs.rmSync(tmp, { recursive: true, force: true })
const ok = rows.every((r) => r.pass)
fs.writeFileSync(OUT, JSON.stringify({ allPass: ok, rows }, null, 1)); console.log(JSON.stringify({ allPass: ok, rows: rows.map((r) => [r.name, r.pass]) })); process.exit(ok ? 0 : 1)
