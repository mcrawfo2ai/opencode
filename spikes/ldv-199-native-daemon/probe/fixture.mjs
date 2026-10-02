// LDV-199 PTY fixture: runs INSIDE the native PTY. Scenario-driven, gate/ack files are the only control plane.
// Everything it emits to the PTY is also appended to an oracle file written through a separate path (not via the PTY).
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

const scenario = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const dir = scenario.dir
const oraclePath = scenario.oracle ?? path.join(dir, "oracle.bin")
const oracleFd = fs.openSync(oraclePath, "a")
let oracleLen = fs.fstatSync(oracleFd).size
let seq = scenario.seqStart ?? 0
const tag = scenario.name

for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      fs.appendFileSync(path.join(dir, "signals.log"), `${tag} ${sig} wall_ms=${Date.now()}\n`)
    } catch {}
    process.removeAllListeners(sig)
    process.kill(process.pid, sig)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const writePty = (buf) => new Promise((resolve, reject) => process.stdout.write(buf, (err) => (err ? reject(err) : resolve())))

async function emit(buf) {
  fs.writeSync(oracleFd, buf)
  oracleLen += buf.length
  await writePty(buf)
}

function record(n) {
  // 64 bytes: R + 10 digit seq + '|' (12) + 51 hex + '\n'
  const hex = createHash("sha256").update(`${tag}:${n}`).digest("hex").slice(0, 51)
  return Buffer.from(`R${String(n).padStart(10, "0")}|${hex}\n`, "ascii")
}

function ack(name, extra = null) {
  const body = { name, wall_ms: Date.now(), mono_ns: String(process.hrtime.bigint()), pid: process.pid, oracle_len: oracleLen, extra }
  const final = path.join(dir, "acks", `${name}.json`)
  fs.writeFileSync(final + ".tmp", JSON.stringify(body))
  fs.renameSync(final + ".tmp", final)
}

async function gate(name, timeoutMs = 180000) {
  const file = path.join(dir, "gates", name)
  const until = Date.now() + timeoutMs
  while (!fs.existsSync(file)) {
    if (Date.now() > until) {
      ack(`gate-timeout-${name}`)
      process.exit(99)
    }
    await sleep(10)
  }
}

function mode() {
  const saved = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" })
  const before = spawnSync("stty", ["-a"], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" })
  const set = spawnSync("stty", ["-echo", "-opost"], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" })
  const after = spawnSync("stty", ["-a"], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8" })
  const flags = (after.stdout ?? "").split(/\s+/)
  const info = {
    saved_stty_g: (saved.stdout ?? "").trim(),
    set_status: set.status,
    set_stderr: set.stderr,
    before_a: before.stdout,
    after_a: after.stdout,
    echo_off: flags.includes("-echo"),
    opost_off: flags.includes("-opost"),
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
    isTTY: !!process.stdout.isTTY,
    env_keys: Object.keys(process.env).sort(),
    pid: process.pid,
    ppid: process.ppid,
  }
  fs.writeFileSync(path.join(dir, "mode.json"), JSON.stringify(info))
  return info
}

for (const step of scenario.steps) {
  switch (step.op) {
    case "mode":
      mode()
      break
    case "emit":
      await emit(Buffer.from(step.text, "utf8"))
      break
    case "records": {
      const chunk = step.chunk ?? 262144
      const target = step.upto // cumulative record bytes emitted so far (excl. non-record text)
      let emitted = seq * 64
      while (emitted < target) {
        const n = Math.min(chunk, target - emitted) / 64
        const parts = []
        for (let i = 0; i < n; i++) parts.push(record(seq++))
        const buf = Buffer.concat(parts)
        await emit(buf)
        emitted += buf.length
      }
      break
    }
    case "ack":
      ack(step.name, step.extra ?? null)
      break
    case "gate":
      await gate(step.name)
      break
    case "exit":
      await new Promise((r) => process.stdout.write("", r))
      process.exit(step.code)
  }
}
