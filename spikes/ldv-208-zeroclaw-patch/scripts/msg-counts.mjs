// Prints /api/sessions/S/messages snapshots per scenario: label, t_ms, status, message count, roles with short head.
// usage: bun msg-counts.mjs <evidence-run-dir> [scenario-prefix]
import fs from "node:fs"
import path from "node:path"
const dir = process.argv[2], pre = process.argv[3] ?? ""
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".snapshots.json") && f.startsWith(pre)).sort()) {
  const snaps = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
  console.log(f.replace(".snapshots.json", ""))
  for (const s of snaps) {
    const m = s.messages?.body?.messages ?? []
    console.log(`  ${String(s.label).padEnd(22)} t=${Math.round(s.t_ms)} status=${s.messages?.status} n=${m.length}`, m.map((x) => `${x.role}:${String(x.content).replace(/^\[CURRENT DATE[^\]]*\]\s*/, "").slice(0, 28).replace(/\n/g, " ")}`).join(" | "))
  }
}
