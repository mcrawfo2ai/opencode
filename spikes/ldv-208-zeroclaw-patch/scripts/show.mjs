// Compact per-socket frame sequence printer: bun show.mjs <evidence-dir> <scenario...>
import fs from "node:fs"
const [dir, ...names] = process.argv.slice(2)
for (const n of names) {
  const s = JSON.parse(fs.readFileSync(`${dir}/${n}.summary.json`, "utf8"))
  console.log(`=== ${n} session=${s.session}`)
  console.log("timeline:", s.timeline.map((e) => `${Math.round(e.t_ms)}:${e.stage}${e.label ? "(" + e.label + ")" : ""}${e.on ? "@" + e.on : ""}`).join(" | "))
  for (const [k, v] of Object.entries(s.sockets)) {
    console.log(`-- socket ${k} close=${JSON.stringify(v.close)} frames=${v.frames.length}`)
    for (const f of v.frames) console.log(`  ${Math.round(f.t_ms)} ${f.type} ${f.brief.slice(0, 110)}`)
  }
  for (const sn of s.snapshots) console.log(`snap ${sn.label} @${Math.round(sn.t_ms)} status=${sn.status} n=${sn.count}`, JSON.stringify(sn.roles_heads))
  console.log("stub:", s.stub_log_slice.map((e) => `${Math.round(e.mono_ms)}:${e.kind}${e.gate ? "/" + e.gate : ""}${e.finish ? "/" + e.finish : ""}`).join(" "))
}
