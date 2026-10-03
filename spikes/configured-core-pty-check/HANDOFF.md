# Configured plugin-to-Core PTY experiment — cloud handoff

**Bottom line: H = `blocked-prerequisite`, I = `blocked-prerequisite`.** No `pty_spawn` invocation, PTY, native daemon or session was created. Bootstrap ran and was fenced. A setup-stage adverse finding came out of it (§4.1). This is experimental input only. It is not a capability, acceptance, notification or review verdict.

## 1. Identity and pins

| Item | Value |
|---|---|
| Fork / branch | https://github.com/mcrawfo2ai/opencode, `spike/configured-core-pty-check` (new branch; it did not exist before this run) |
| Untouched base | `591c6999ebceb86f1b4869685d87bc2e10d9a333` (verified as `HEAD` before branching) |
| Experiment head | The single commit that adds this directory. Its hash is reported in the cloud reply and in `git log`; a commit cannot contain its own hash. |
| Cloud session/model | Not resolved. `get_session` was not called, so this is unavailable. |
| Plugin | `internetisalie/opencode-pty` @ `0c95fc39a66ea19cf287908eb1def07972f23983`, version `0.5.0`. Public read-only `git clone`; `HEAD` verified after checkout. |
| Toolchain | Declared `packageManager: bun@1.4.2`. The ambient bun was `1.3.14` and was **not used** for host execution. Bun `1.4.2+744846f84` came from the public GitHub release `bun-v1.4.2/bun-linux-x64.zip`, sha256 `36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913`. This matches the release `SHASUMS256.txt`. Runtime executable sha256 is `a83d2637…dda0c` (see `evidence/run1/host-identity.txt`). |
| Host deps | `bun install --frozen-lockfile --ignore-scripts` at repo root, exit **1**. 2408 packages installed. 2 failed with proxy 403: `ghostty-web@github:anomalyco/ghostty-web#83c0a07` and `@solidjs/start@pkg.pr.new`. Neither was needed by the `serve` path that ran. Postinstall scripts were skipped. |
| Native producer | `@opencode-ai/pty@0.1.13` and `@opencode-ai/pty-linux-x64-gnu@0.1.13`, from the lockfile (`bun.lock` lines 2125/2135, integrity sha512 recorded there). Binary `node_modules/.bun/@opencode-ai+pty-linux-x64-gnu@0.1.13/node_modules/@opencode-ai/pty-linux-x64-gnu/bin/opencode-pty`: **3138672 bytes**, sha256 **`b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa`** (matches expected). ELF 64-bit x86-64 PIE, GNU ld-linux. Host is x86_64, glibc 2.39. Passed to the host as an absolute `OPENCODE_PTY_BIN`. **It was never executed**, so there is no runtime instance, PID or ping. |
| Host resources | 4 CPU, 16 GB RAM, 30 GB disk available. Installs were serialized. No typecheck or build was run. |

## 2. Input packet and read ledger

All 7 starter files matched the brief's bytes and hashes exactly (25782 bytes).

The brief size B was **not measured**. It was delivered as a chat message, not a file, so its hash is unavailable. Estimated B ≈ 24–26 KB.

| Read (complete region) | Containing file bytes / sha256 | Region bytes |
|---|---|---:|
| starter set (7 files) | per brief | 25782 |
| `packages/core/src/config/plugin/source.ts` L113–200 (`parse`, `scan`, `isPluginSource`) | 7896 / `ea779382…82e5` | 3877 |
| `packages/core/src/plugin/module.ts` full (`make`, `Module`, `load`) | 5449 / `ba12530e…1601` | 5449 |
| `packages/plugin/src/promise/adapter.ts` L240–295 (`promiseExecutor`, `transform`) | 28940 / `c6983fcf…8ae5` | 2525 |
| same, L465–500 + L616–640 (`tool.list/transform`, `executePromiseTool`) | same | 1983 |
| `packages/cli/src/server-process.ts` L1–200 (non-empty, first 170 lines) | 9075 / `408e6b9d…0d3f` | 7604 |
| `packages/cli/src/commands/handlers/serve.ts` full | 691 / `b136a083…dc55` | 691 |
| `packages/cli/src/commands/commands.ts` L515–530 (`serve` spec) | 20919 / `1b2bb7ea…5175` | 603 |
| `packages/schema/src/config/plugin.ts` full | 444 / `5f90fda6…21bf3` | 440 |
| Navigation, grep and status outputs (≈20 calls) | — | ≈22000 (estimate) |

- **Total ≈ 71 KB + B ≈ 95–97 KB.** This is close to the 100 KB yellow line, so discovery stopped there, short of the 128 KB red.
- Navigation exceeded the 4096-byte allowance. It was not metered per call; the figure above is an estimate.
- No repeated reads of the same content.
- Mandatory baseline: `AGENTS.md` was loaded via the system context. It was not re-read and is not counted above.
- No TypeScript LSP resolution was done. Every type below is spelling or body evidence only.

## 3. Instruments (all committed, sha256)

- `instrument/bootstrap.sh` (`5d331d98…91cf`): a bounded isolated launch.
  - Uses `env -i` with an allowlist and creates fresh HOME, XDG_*, TMPDIR, DB and PTY runtime directories under the run root.
  - Generates a random password in shell memory and passes it as `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`.
  - Pre-picks a loopback port (bind to port 0, then release; there is a TOCTOU window).
  - Supplies config via `OPENCODE_CONFIG_CONTENT`, with project config, models fetch, autoupdate and filewatcher disabled.
  - The child does not get `HTTPS_PROXY` or any proxy variable.
  - Applies the fence, then SIGTERM.
- `probe-plugin/index.ts` (`3df289e2…1dcf`): an owned, read-only probe of the launched host's `ctx.tool.list()`. It **never ran** (see §4.2).
- Commands, run from the scratchpad with `RUN_ROOT=<scratch>/run1` and `EVID=spikes/configured-core-pty-check/evidence/run1`, plus `BUN_DIR`, `PLUGIN_DIR` and `PTY_BIN` as in §1:
  - `timeout 120 instrument/bootstrap.sh` → exit 0.
  - Offline entry check: `bun -e` using `Host.resolve` and `Host.load` from `packages/plugin/src/host.ts` → exit 0, output in `evidence/entry-selection.json`.

## 4. Results

### 4.1 Setup: entry selection is adverse for the package-root directory (`evidence/entry-selection.json`, `3853d949…b24e2`)

Real `Host.resolve` and `Host.load` were run outside the server; this is preparation evidence, not a configured load.

- **Plugin root directory → `file://<PLUGIN>/index.ts`, which is the v1 entry.** Its exports are `PTYPlugin` and `server`, with **no default export**.
  - Reading `module.ts`, this fails the `Module` decode with `PluginModule.LoadError`.
  - The package `exports` map that points `./server` at the v2 dist is **not consulted** for a configured directory: `Host.resolve` without a `name` uses `path.resolve(directory, "server" | "index")`.
  - So configuring the pinned plugin by its package root does not load v2.
- **`<PLUGIN>/src/v2` directory → `src/v2/index.ts`.** It has a default export with `id: "opencode-pty"` and a `setup` function.
  - This is the configuration the bootstrap used (shape in `evidence/run1/config-shape.txt`).
  - It is a real pinned source file, but it is a configured *subdirectory*, not the published package entry.

### 4.2 Bootstrap (`evidence/run1/host-identity.txt`, `8ee81221…b0ee`)

- `bun src/index.ts serve --hostname 127.0.0.1 --port <pre-picked>` started as PID 1587 (starttime and boot_id recorded). It printed `server listening on http://127.0.0.1:38361` after about 3.6 s.
- **OS listener-ownership fence passed:** the LISTEN inode 6175 on that port is an fd of PID 1587.
- **No returned-identity field was grounded.** Under the brief's rule, no ordinary request was sent: no config, registry, session or tool call.
- stderr was empty and the probe never logged. **Configured plugin activation was not observed.**
  - The `plugin-routes.ts` comment (spelling evidence only) says plugins run at Location activation. That is presumably triggered by a request, which the fence forbade.
- No `opencode-pty` process existed. An exact `pgrep -x opencode-pty` after the run returned exit 1. The native daemon was never started.
- Intentional server end: the starttime fence was re-checked and matched, then SIGTERM was sent. The host exited with status **130** (an intentional-end outcome, not a natural exit). No owned survivors.

### 4.3 Case outcomes

| Case | Outcome | Reason / last state |
|---|---|---|
| H | `blocked-prerequisite` | No real invoker of the registered tool path was grounded. That needs the session runner caller, `Tool.Context` declarations, the `pty_spawn` permission flow, session create/prompt endpoints, and a deterministic local model fixture (provider config schema plus the `@ai-sdk/openai-compatible` stream and tool-call envelopes). Those reads would exceed the remaining budget. The live load/registry precondition is also unestablished (§4.2). Fake ctx, a direct module call or a direct Core create were deliberately not used. Last state: the server was booted, fenced and stopped, with no plugin activation observed. |
| I | `blocked-prerequisite` | Depends on H. The selected-session and current-terminal controller machinery (declarations and runtime) was also not grounded. |

- Byte continuity: **none established.** No PTY ran, and there is no receiver or independent tee oracle.
- Raw native exit codes, Core status mappings, EOF and Removed: none observed.

## 5. Offline negative controls

**Not run.** No H/I evidence exists to check, and no checker was written. A list of intended controls would not be evidence.

## 6. External network

- Public acquisition only:
  - `github.com` git clone of opencode-pty: allowed.
  - Bun release zip and `SHASUMS256.txt`: allowed.
  - npm registry through the agent proxy for the frozen install: allowed, except two 403s for `github:anomalyco/ghostty-web` and `pkg.pr.new`.
- The host child got no proxy variables, and models fetch was disabled.
- No loopback model fixture existed, and **no real model or provider traffic** occurred. The child sent no requests.
- Child egress was not packet-captured, so whether the child attempted any outbound connection is unknown.

## 7. Redaction and cleanup

- Password, run root, plugin path and repo path were replaced by `sed` before anything was written to disk.
- Limitation: the password briefly appeared in the redact `sed` process argv. It was visible to same-host process listings and was redacted in `children.txt`.
- Two raw `pgrep -f` captures matched the operator's own shell command line. That is contamination, so they were **deleted and not committed**.
- No `service.json`, auth frames or dependency trees are committed.
- The run root `<scratch>/run1` (bun cache, DB dirs) stays in the sandbox scratchpad and is not committed. No owned process is left.

## 8. Not done, and why

- **H and I measurements:** blocked (§4.3).
- **Real invocation, model fixture, sessions A/B, selection changes, MID/FINAL gates, byte oracle and offline controls:** none done. They are blocked behind the invoker and read budget.
- **Returned host identity exchange:** the endpoint was not grounded.
- **Native ping, instance and PID:** the daemon never started.
- **LSP type resolution:** not performed.
- **Exact B measurement and hash:** not possible, because the brief was not delivered as a file.

Suggested next prerequisites to admit within a fresh budget:

- The session prompt/runner caller and `Tool.Context`.
- The permission ask path for `pty_spawn`.
- Provider config plus the openai-compatible stream envelope.
- A grounded health/identity endpoint.
- The Location-activation trigger.
- Whether the operator accepts `src/v2` subdirectory configuration as "the real plugin" given §4.1.
