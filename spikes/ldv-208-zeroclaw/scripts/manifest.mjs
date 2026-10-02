// usage: bun scripts/manifest.mjs write|verify   (run from spikes/ldv-208-zeroclaw)
// MANIFEST self-entry: its digest is computed over the MANIFEST bytes with ONLY its own 64-hex digest field replaced by 64 zeroes.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
const ZERO = "0".repeat(64)
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
const files = walk(".").map((f) => f.replace(/^\.\//, "")).filter((f) => f !== "MANIFEST").sort()
const header = "# MANIFEST: sha256  bytes  path\n# Self-entry normalization: the digest of MANIFEST itself is sha256 of this file's bytes with only the 64-hex digest on the MANIFEST line replaced by 64 zeroes.\n"
if (process.argv[2] === "write") {
  const rows = files.map((f) => `${sha(fs.readFileSync(f))}  ${fs.statSync(f).size}  ${f}`)
  const bodyWith = (d) => header + rows.join("\n") + `\n${d}  SELF  MANIFEST\n`
  fs.writeFileSync("MANIFEST", bodyWith(sha(Buffer.from(bodyWith(ZERO)))))
} else {
  const text = fs.readFileSync("MANIFEST", "utf8"); const errs = []
  const listed = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s{2}/))
  for (const [d, size, f] of listed) { if (f === "MANIFEST") { const self = sha(Buffer.from(text.replace(d, ZERO))); if (self !== d) errs.push("MANIFEST self digest mismatch") } else if (!fs.existsSync(f) || sha(fs.readFileSync(f)) !== d || String(fs.statSync(f).size) !== size) errs.push("mismatch " + f) }
  const names = new Set(listed.map((r) => r[2])); for (const f of files) if (!names.has(f)) errs.push("unlisted " + f)
  console.log(JSON.stringify({ ok: errs.length === 0, entries: listed.length, errs })); process.exit(errs.length ? 1 : 0)
}
