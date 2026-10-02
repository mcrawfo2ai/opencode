// Prints, per socket, the frame-type sequence of every scenario in an evidence dir (reads *.raw.jsonl only).
// usage: bun frame-seq.mjs <evidence-run-dir> [scenario-prefix]
import fs from "node:fs"
import path from "node:path"
const dir = process.argv[2], pre = process.argv[3] ?? ""
const abbr = { session_start: "SS", chunk: "CH", tool_call: "TC", tool_result: "TR", done: "DN", approval_request: "AR", error: "ERR", thinking: "TH", aborted: "AB" }
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".raw.jsonl") && f.startsWith(pre)).sort()) {
  const rows = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const out = []
  const turns = new Set()
  for (const r of rows) {
    if (r.ev === "message") {
      let d; try { d = JSON.parse(r.data) } catch { out.push(`?@${Math.round(r.t_ms)}`); continue }
      if (d.turn_id) turns.add(d.turn_id.slice(0, 8))
      out.push(`${abbr[d.type] ?? d.type}${d.seq ? "#" + d.seq : ""}${d.replay ? "(r)" : ""}@${Math.round(r.t_ms)}`)
    } else if (r.ev === "close") out.push(`close@${Math.round(r.t_ms)}`)
  }
  console.log(f.replace(".raw.jsonl", ""), `[${out.filter((x) => !x.startsWith("close")).length}]`, out.join(" "), turns.size ? ` turn_ids=${[...turns].join(",")}` : "")
}
