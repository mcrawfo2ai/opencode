// Offline coverage check: compares extracted contract against the BRIEF's inventory (not the extractor's list).
// Usage: bun verify-coverage.mjs <brief-inventory.json> <extracted-contract.json> <extraction-report.json>
import fs from "node:fs"
export function checkCoverage(inv, ext, rep) {
  const errs = []
  for (const o of inv.operations) {
    const hit = ext.operations.find((e) => e.method === o.method && e.path === o.path)
    if (!hit) errs.push(`MISSING_ROUTE ${o.method.toUpperCase()} ${o.path}`)
    else if (hit.operation.operationId !== o.operationId) errs.push(`OPERATION_ID_MISMATCH ${o.path}: ${hit.operation.operationId} != ${o.operationId}`)
  }
  for (const e of inv.events) if (!ext.components.schemas[e]) errs.push(`MISSING_EVENT_SCHEMA ${e}`)
  if (rep.unresolvedReferences.length) errs.push(`UNRESOLVED_REFS ${rep.unresolvedReferences.length}`)
  // Every $ref in the extract must resolve inside the extract, except disclosed excluded Event-union members.
  const excluded = new Set(rep.eventUnion.excludedMembers)
  const dangling = new Set()
  ;(function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n && typeof n === "object") { if (typeof n.$ref === "string") { const name = n.$ref.split("/").pop(); const kind = n.$ref.split("/")[2]; if (!ext.components[kind]?.[name] && !excluded.has(name)) dangling.add(n.$ref) } Object.values(n).forEach(walk) }
  })([ext.operations, ext.components])
  if (dangling.size) errs.push(`DANGLING_REFS ${[...dangling].slice(0, 5).join(",")}`)
  return errs
}
if (import.meta.main) {
  const [a, b, c] = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, "utf8")))
  const errs = checkCoverage(a, b, c)
  console.log(JSON.stringify({ ok: errs.length === 0, inventoryOps: a.operations.length, inventoryEvents: a.events.length, errors: errs }))
  process.exit(errs.length ? 1 : 0)
}
