import { Database } from "bun:sqlite"
const db = new Database(process.argv[2], { readonly: true })
console.log(db.query(`pragma table_info("event")`).all().map((c: any) => c.name))
const rows = db.query(`select type, count(*) n, sum(length(data)) b, max(length(data)) mx from event group by type order by b desc limit 12`).all() as any[]
for (const r of rows) console.log(r.type, r.n, Math.round(r.b / 1e6) + "MB", "max", Math.round(r.mx / 1e6) + "MB")
