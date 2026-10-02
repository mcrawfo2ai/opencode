// Collapse sampler output into runs of identical (running,state) readings: bun samples-digest.mjs <evidence-dir> <scenario...>
import fs from "node:fs"
const [dir, ...names] = process.argv.slice(2)
for (const n of names) {
  const s = JSON.parse(fs.readFileSync(`${dir}/${n}.samples.json`, "utf8")); const sum = JSON.parse(fs.readFileSync(`${dir}/${n}.summary.json`, "utf8"))
  const key = (x) => JSON.stringify([x.running.status, x.running.body ?? x.running.error, x.state.status, x.state.body ?? x.state.error])
  console.log(`=== ${n}: ${s.length} samples`)
  let prev = null, start = null, count = 0, last = null
  const flush = () => prev && console.log(`  ${Math.round(start)}..${Math.round(last)}ms x${count}  ${prev.slice(0, 260)}`)
  for (const x of s) { const k = key(x); if (k !== prev) { flush(); prev = k; start = x.t_ms; count = 0 } count++; last = x.t_ms }
  flush()
  console.log("  stages:", sum.timeline.filter((e) => e.stage !== "snapshot").map((e) => `${Math.round(e.t_ms)}:${e.stage}`).join(" "))
}
