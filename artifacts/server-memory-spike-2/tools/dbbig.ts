import { Database } from "bun:sqlite"
const db = new Database(process.argv[2], { readonly: true })
const r = db.query(`select seq, data from event where type='message.updated.1' order by length(data) desc limit 1`).get() as any
const d = JSON.parse(r.data)
const walk = (o: any, p: string, depth: number) => {
  if (depth > 5 || o === null || typeof o !== "object") return
  for (const [k, v] of Object.entries(o)) {
    const n = JSON.stringify(v)?.length ?? 0
    if (n > 1e6) console.log(p + "." + k, Math.round(n / 1e6) + "MB", Array.isArray(v) ? `array[${v.length}]` : typeof v)
    walk(v, p + "." + k, depth + 1)
  }
}
walk(d, "data", 0)
const sizes = (db.query(`select seq, length(data) l from event where type='message.updated.1' order by seq`).all() as any[]).map((x) => Math.round(x.l / 1e6))
console.log("sizes by seq (MB), every 20th:", sizes.filter((_, i) => i % 20 === 0))
