// Throwaway extractor: selects only the brief's operations + listed event schemas
// from the pinned OpenCode OpenAPI document, plus recursively referenced components.
// Usage: bun scripts/extract-contract.mjs <openapi.json> <outdir>
import fs from "node:fs"
import crypto from "node:crypto"

const specPath = process.argv[2]
const outDir = process.argv[3]
const raw = fs.readFileSync(specPath)
const spec = JSON.parse(raw.toString("utf8"))

// Own selection list (deliberately NOT shared with verify-coverage.mjs, which parses the brief).
const OPS = [
  ["get", "/global/health"], ["get", "/session/status"], ["get", "/session"], ["post", "/session"],
  ["get", "/session/{sessionID}"], ["patch", "/session/{sessionID}"], ["delete", "/session/{sessionID}"],
  ["post", "/session/{sessionID}/prompt_async"], ["post", "/session/{sessionID}/message"],
  ["get", "/session/{sessionID}/message"], ["get", "/session/{sessionID}/message/{messageID}"],
  ["post", "/session/{sessionID}/abort"], ["get", "/session/{sessionID}/children"],
  ["get", "/session/{sessionID}/diff"], ["get", "/session/{sessionID}/todo"],
  ["post", "/session/{sessionID}/fork"], ["get", "/permission"], ["post", "/permission/{requestID}/reply"],
  ["get", "/event"], ["get", "/global/event"], ["get", "/agent"], ["get", "/provider"],
  ["get", "/question"], ["post", "/question/{requestID}/reply"], ["post", "/question/{requestID}/reject"],
]
const EVENTS = [
  "EventMessagePartDelta", "EventMessagePartRemoved", "EventMessagePartUpdated", "EventMessageRemoved",
  "EventMessageUpdated", "EventPermissionAsked", "EventPermissionReplied", "EventQuestionAsked",
  "EventQuestionRejected", "EventQuestionReplied", "EventServerConnected", "EventSessionCompacted",
  "EventSessionCreated", "EventSessionDeleted", "EventSessionDiff", "EventSessionError",
  "EventSessionIdle", "EventSessionStatus", "EventSessionUpdated",
]

const comp = spec.components
const unionMembers = (comp.schemas.Event.anyOf ?? []).map((m) => m.$ref.split("/").pop())
const eventUnionSet = new Set(unionMembers)
const listed = new Set(EVENTS)
const excludedMembers = unionMembers.filter((n) => !listed.has(n))

const selected = {} // kind -> name -> object
const unresolved = new Set()
const excludedReferenced = new Set()
const refEdges = []
const queue = []
const views = {}

function enqueue(ref, from) {
  const m = /^#\/components\/([^/]+)\/(.+)$/.exec(ref)
  if (!m) return unresolved.add(`${ref} (from ${from})`)
  const [, kind, name] = m
  if (!comp[kind]?.[name]) return unresolved.add(`${ref} (from ${from})`)
  refEdges.push([from, ref])
  if (kind === "schemas" && eventUnionSet.has(name) && !listed.has(name)) {
    excludedReferenced.add(name)
    return
  }
  selected[kind] ??= {}
  if (selected[kind][name]) return
  selected[kind][name] = true
  queue.push([kind, name])
}

function walk(node, from) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, from))
  if (node && typeof node === "object") {
    if (typeof node.$ref === "string") enqueue(node.$ref, from)
    for (const v of Object.values(node)) walk(v, from)
  }
}

// GlobalEvent.payload is an INLINE anyOf of all event shapes; keep only listed event types.
const listedTypes = new Set()
for (const n of EVENTS) {
  const t = JSON.stringify(comp.schemas[n]).match(/"type":\{"type":"string","enum":\["([^"]+)"\]/)
  if (t) listedTypes.add(t[1])
}
const inlineFiltered = {}
// Applies to any anyOf of >20 event-shaped members (inline objects with type enum, or $refs to Event*/SyncEvent*):
// keep listed members, record excluded ones (inline by type string, $ref by schema name).
function viewSchema(name, schema) {
  const out = structuredClone(schema)
  const hits = []
  ;(function visit(n, p) {
    if (n && typeof n === "object") {
      if (name !== "Event" && Array.isArray(n.anyOf) && n.anyOf.length > 20) {
        const typeOf = (m) => m.properties?.type?.enum?.[0]
        const refName = (m) => m.$ref?.split("/").pop()
        const isListed = (m) => (m.$ref ? listed.has(refName(m)) : listedTypes.has(typeOf(m)))
        const keep = n.anyOf.filter(isListed)
        const dropped = n.anyOf.filter((m) => !isListed(m))
        hits.push({ path: p, total: n.anyOf.length, kept: keep.map((m) => refName(m) ?? typeOf(m)), droppedInlineTypes: dropped.filter((m) => !m.$ref).map(typeOf), droppedRefs: dropped.filter((m) => m.$ref).map(refName) })
        n.anyOf = keep
        n["x-spike-excluded-member-types"] = dropped.filter((m) => !m.$ref).map(typeOf)
        n["x-spike-excluded-member-refs"] = dropped.filter((m) => m.$ref).map(refName)
      }
      for (const [k, v] of Object.entries(n)) visit(v, `${p}/${k}`)
    }
  })(out, `#/components/schemas/${name}`)
  if (hits.length) inlineFiltered[name] = hits
  return out
}

const operations = []
for (const [method, path] of OPS) {
  const item = spec.paths[path]
  const op = item?.[method]
  if (!op) { unresolved.add(`OPERATION ${method.toUpperCase()} ${path} not in spec`); continue }
  const entry = { method, path, pathLevelParameters: item.parameters, operation: op }
  operations.push(entry)
  walk(entry, `${method.toUpperCase()} ${path}`)
}
for (const n of EVENTS) {
  if (!comp.schemas[n]) { unresolved.add(`EVENT ${n} not in components.schemas`); continue }
  enqueue(`#/components/schemas/${n}`, "brief-event-list")
}
// Process transitive closure
while (queue.length) {
  const [kind, name] = queue.shift()
  const v = kind === "schemas" ? viewSchema(name, comp[kind][name]) : comp[kind][name]
  views[`${kind}/${name}`] = v
  walk(v, `#/components/${kind}/${name}`)
}
// If Event union itself got selected, keep its full member $ref list (preserved), only listed members expanded.
const components = {}
for (const kind of Object.keys(selected)) {
  components[kind] = {}
  for (const name of Object.keys(selected[kind]).sort()) {
    components[kind][name] = views[`${kind}/${name}`]
  }
}
if (spec.security) components.__securityTopLevel = spec.security

const out = {
  source: { path: specPath, bytes: raw.length, sha256: crypto.createHash("sha256").update(raw).digest("hex"), openapi: spec.openapi },
  operations,
  components,
}
fs.mkdirSync(outDir, { recursive: true })
const contractText = JSON.stringify(out, null, 1)
fs.writeFileSync(`${outDir}/extracted-contract.json`, contractText)
const counts = Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, Object.keys(v).length]))
const report = {
  specBytes: raw.length,
  extractedContractBytes: Buffer.byteLength(contractText),
  operationsSelected: operations.map((o) => `${o.method.toUpperCase()} ${o.path} ${o.operation.operationId}`),
  eventsRequested: EVENTS,
  componentCounts: counts,
  selectedComponentRefs: Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, Object.keys(v).sort()])),
  unresolvedReferences: [...unresolved].sort(),
  eventUnion: { totalMembers: unionMembers.length, expandedMembers: unionMembers.filter((n) => listed.has(n)), excludedMembers },
  excludedEventSchemasReferencedByExtract: [...excludedReferenced].sort(),
  inlineEventUnionFiltering: inlineFiltered,
  listedEventTypeStrings: [...listedTypes].sort(),
}
fs.writeFileSync(`${outDir}/extraction-report.json`, JSON.stringify(report, null, 1))
console.log(JSON.stringify({ extractedContractBytes: report.extractedContractBytes, counts, unresolved: report.unresolvedReferences.length, excludedMembers: excludedMembers.length, excludedReferenced: report.excludedEventSchemasReferencedByExtract.length, inline: Object.fromEntries(Object.entries(inlineFiltered).map(([k,v])=>[k,v.map(h=>[h.path,h.total,h.kept.length])])) }))
