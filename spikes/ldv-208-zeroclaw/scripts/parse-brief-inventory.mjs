// Parses the brief's own inventory table + event list into data/brief-inventory.json (independent of extractor's list).
import fs from "node:fs"
import crypto from "node:crypto"
const briefPath = process.argv[2], out = process.argv[3]
const raw = fs.readFileSync(briefPath); const text = raw.toString("utf8")
const rows = [...text.matchAll(/^\|\s*(GET|POST|PATCH|DELETE|PUT)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*$/gm)].map((m) => ({ method: m[1].toLowerCase(), path: m[2], operationId: m[3], summary: m[4] }))
const evBlock = text.split("Event schemas of interest (components.schemas):")[1].split("Out of scope")[0]
const events = [...evBlock.matchAll(/^- `([A-Za-z]+)`/gm)].map((m) => m[1])
fs.writeFileSync(out, JSON.stringify({ brief: { bytes: raw.length, sha256: crypto.createHash("sha256").update(raw).digest("hex") }, operations: rows, events }, null, 1))
console.log(JSON.stringify({ ops: rows.length, events: events.length, briefBytes: raw.length }))
