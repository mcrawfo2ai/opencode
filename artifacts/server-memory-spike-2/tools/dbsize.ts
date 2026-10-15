import { Database } from "bun:sqlite"
const db = new Database(process.argv[2], { readonly: true })
const tables = db.query("select name from sqlite_master where type='table'").all() as { name: string }[]
const out = []
for (const t of tables) {
  const cols = (db.query(`pragma table_info("${t.name}")`).all() as { name: string }[]).map((c) => c.name)
  const sum = cols.map((c) => `coalesce(sum(length("${c}")),0)`).join("+")
  const r = db.query(`select count(*) as n, ${sum || 0} as bytes from "${t.name}"`).get() as { n: number; bytes: number }
  out.push({ table: t.name, rows: r.n, MB: Math.round(r.bytes / 1e6) })
}
out.sort((a, b) => b.MB - a.MB)
console.log(out.slice(0, 10))
