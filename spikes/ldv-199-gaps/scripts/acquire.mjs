// LDV-199 gaps: acquire the exact public native package WITHOUT install hooks and record identities.
// Run only through the private-/tmp wrapper.  usage: node acquire.mjs <download-dir> <out-json>
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const dir = process.argv[2]
const out = process.argv[3]
const PIN = { size: 3138672, sha256: "b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa" }
const sha = (b, a = "sha256") => createHash(a).update(b).digest("hex")
fs.mkdirSync(dir, { recursive: true })
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", cwd: dir, ...opts })

const rec = { started: new Date().toISOString(), tool: { node: process.version, npm: run("npm", ["--version"]).trim() } }
// --ignore-scripts: no lifecycle/install hooks run; npm pack only downloads tarballs
const packOut = run("npm", ["pack", "@opencode-ai/pty-linux-x64-gnu@0.1.13", "@opencode-ai/pty@0.1.13", "--ignore-scripts", "--json"])
rec.npm_pack_json = JSON.parse(packOut).map((p) => ({ name: p.name, version: p.version, filename: p.filename, size: p.size, unpackedSize: p.unpackedSize, shasum: p.shasum, integrity: p.integrity, fileCount: p.files?.length }))

for (const [key, file, extract] of [
  ["native", "opencode-ai-pty-linux-x64-gnu-0.1.13.tgz", "native"],
  ["parent", "opencode-ai-pty-0.1.13.tgz", "parent"],
]) {
  const p = path.join(dir, file)
  const bytes = fs.readFileSync(p)
  const ex = path.join(dir, extract)
  fs.rmSync(ex, { recursive: true, force: true })
  fs.mkdirSync(ex)
  run("tar", ["-xzf", p, "-C", ex])
  const inv = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else {
        const st = fs.lstatSync(f)
        inv.push({ path: path.relative(path.join(ex, "package"), f), bytes: st.size, mode: (st.mode & 0o7777).toString(8), symlink: st.isSymbolicLink(), sha256: sha(fs.readFileSync(f)) })
      }
    }
  }
  walk(ex)
  rec[key] = {
    tarball: file,
    tarball_bytes: bytes.length,
    tarball_sha1: sha(bytes, "sha1"),
    tarball_sha256: sha(bytes),
    tarball_sha512_integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    tar_listing: run("tar", ["-tvzf", p]).trim().split("\n"),
    inventory: inv.sort((a, b) => a.path.localeCompare(b.path)),
  }
}
const exePath = path.join(dir, "native/package/bin/opencode-pty")
const exe = fs.readFileSync(exePath)
const st = fs.lstatSync(exePath)
rec.executable = { path: exePath, bytes: exe.length, sha256: sha(exe), mode: (st.mode & 0o7777).toString(8), symlink: st.isSymbolicLink(), expected: PIN, size_ok: exe.length === PIN.size, sha256_ok: sha(exe) === PIN.sha256 }
rec.native_package_json = JSON.parse(fs.readFileSync(path.join(dir, "native/package/package.json"), "utf8"))
rec.parent_binding = {
  package_json_name: JSON.parse(fs.readFileSync(path.join(dir, "parent/package/package.json"), "utf8")).name,
  index_js_sha256: sha(fs.readFileSync(path.join(dir, "parent/package/index.js"))),
  note: "index.js resolves binaryPath to @opencode-ai/pty-<platform>-<arch>-<libc>/bin/opencode-pty; not executed here (no hooks, no wrapper)",
}
const glibc = process.report.getReport().header.glibcVersionRuntime
rec.platform = { platform: process.platform, arch: process.arch, libc: glibc ? "gnu" : "musl", glibcVersionRuntime: glibc ?? null }
rec.compatible = rec.platform.platform === "linux" && rec.platform.arch === "x64" && !!glibc && rec.native_package_json.os?.includes("linux") && rec.native_package_json.cpu?.includes("x64") && rec.native_package_json.libc?.includes("glibc")
rec.blocked = !(rec.executable.size_ok && rec.executable.sha256_ok && rec.compatible)
rec.finished = new Date().toISOString()
fs.writeFileSync(out, JSON.stringify(rec, null, 1))
console.log(JSON.stringify({ blocked: rec.blocked, exe: rec.executable.sha256_ok, size: rec.executable.size_ok, compatible: rec.compatible, mode: rec.executable.mode }))
