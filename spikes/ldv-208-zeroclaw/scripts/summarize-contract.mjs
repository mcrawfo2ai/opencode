// Compact, script-derived summary of the extracted contract (what the seat actually reads; the full 145KB JSON is NOT read).
import fs from "node:fs"
const c = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const sch = c.components.schemas
const short = (s) => !s ? "-" : s.$ref ? s.$ref.split("/").pop() : s.type === "array" ? `array<${short(s.items)}>` : s.anyOf ? `anyOf(${s.anyOf.length})` : s.type ?? "object"
const lines = []
for (const o of c.operations) {
  const op = o.operation
  const params = (op.parameters ?? []).map((p) => p.$ref ? p.$ref.split("/").pop() : `${p.in}:${p.name}${p.required ? "*" : ""}:${short(p.schema)}`).join(",")
  const rb = op.requestBody ? Object.entries(op.requestBody.content ?? {}).map(([m, v]) => `${m}=${short(v.schema)}`).join("|") + (op.requestBody.required ? "*" : "") : "-"
  const rs = Object.entries(op.responses).map(([k, v]) => `${k}:${Object.entries(v.content ?? {}).map(([m, x]) => `${m.replace("application/", "")}=${short(x.schema)}`).join("|") || "none"}`).join(" ")
  lines.push(`${o.method.toUpperCase()} ${o.path} [${op.operationId}] params(${params}) body(${rb}) -> ${rs}`)
}
const props = (n, depth = 0) => { const s = sch[n]; if (!s) return `${n}: (not extracted)`; const p = s.properties ? Object.entries(s.properties).map(([k, v]) => `${k}${(s.required ?? []).includes(k) ? "*" : ""}:${short(v)}`).join(", ") : short(s); return `${n} { ${p} }` }
const focus = ["Session", "SessionStatus", "UserMessage", "AssistantMessage", "Message", "Part", "TextPart", "ToolPart", "ToolState", "Permission", "PermissionRequest", "QuestionRequest", "Agent", "Todo", "FileDiff"]
const out = ["## operations", ...lines, "", "## selected schemas (property lists)", ...focus.filter((n) => sch[n]).map((n) => props(n)), "", "## listed events (properties)", ...Object.keys(sch).filter((n) => /^Event/.test(n) && n !== "Event").map((n) => { const e = sch[n]; const t = e.properties?.type?.enum?.[0]; const p = e.properties?.properties; return `${n} type=${t} props=${p?.properties ? Object.keys(p.properties).join(",") : short(p)}` })]
const text = out.join("\n"); fs.writeFileSync(process.argv[3], text); console.log(Buffer.byteLength(text))
