import { Database } from "bun:sqlite"
const db = new Database(process.argv[2], { readonly: true })
const rows = db.query(`select seq, length(data) l from event where type='message.updated.1' order by seq`).all() as any[]
const big = rows.filter((x) => x.l > 1e6)
console.log("events >1MB:", big.length, "of", rows.length, "sum MB", Math.round(big.reduce((a, x) => a + x.l, 0) / 1e6))
console.log("sizes (MB) of >1MB events in order:", big.map((x) => Math.round(x.l / 1e6)).join(","))
