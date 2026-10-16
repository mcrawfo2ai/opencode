# Spike 2: closing the gap between the rig and production

**Summary.**

- **Server process alone:** none of the four production features (project `.opencode/`, gopls, plugins, large provider configs) adds a measurable per-directory cost. All runs stay at 34–40 MiB per directory, the same as the catalog cost found in spike 1.
- **Process tree:** each directory gets its own gopls child of about **150 MiB that is never released**. That makes the tree grow by **~150 MiB per directory**, matching production's 0.16 GiB.
- **The fixes:** spike 1's fixes release the server and gopls costs. The production PTY leak, however, comes from the pty plugin's own copy of `bun-pty`, which needs the same patch.
- **Bursts** reach multi-GB in long sessions with large tool inputs. That is driven by a per-step session-summary diff that is unbounded and re-persisted on every step (Q7).
- **Sockets:** 3 per gopls child plus 1 per event-stream subscriber (Q8).
- **Soak (2 h of a planned 6 h; the container restarted):** with the fixes on, RSS and the JS heap are flat with time. Only the pty plugin's PTY leak grows: +18 pts, +54 ptmx and +38 threads per hour (Q9).

Same build and rules as spike 1: tag `v1.18.32-internetisalie.3` (`f7f6c22`), bun 1.3.14, the extracted models.dev catalog (223 providers, 7,954 models), the `memdump.ts` SIGUSR2 instrument, and the `/proc` sampler, extended with child-process and socket classification. Stub providers only; every API key is the dummy string `x`. Nothing in this repository's runtime code changes.

## 0. Sandbox deviations and setup

| item | production | this rig | why |
|---|---|---|---|
| Build | release build | `bun run script/build.ts --single --skip-embed-web-ui`, `OPENCODE_CHANNEL=latest`, `OPENCODE_VERSION=1.18.32` | The web UI's deps are blocked here. `latest` makes the per-directory `.opencode` install pin `@opencode-ai/plugin@1.18.32`, as a release build does. |
| Builds compared | — | `instr-v2` (tag + memdump) and `proto-v2` (tag + memdump + spike-1 `proto-instance-idle.diff` + bun-pty close-on-exit patch) | |
| Go repo | production Go repos | `golang/vuln` @ d1f3801 (347 files, 122 `.go`), distinct root commit per directory | The Go module proxy is not reachable. All deps are resolved through `replace` directives to GitHub clones (`go build ./...` passes). `golang/text` (540 files) was tried first. Its huge generated tables put gopls at 1–2 GB each, which is unrepresentative and wouldn't fit 20 copies in 15 GB. |
| gopls | `gopls` | gopls v0.20.0, built from `golang/tools` and its `x/` deps' GitHub mirrors | No module proxy. Server env: `GOPROXY=off GOFLAGS=-mod=mod GOSUMDB=off`. |
| LSP config | `"lsp": {"gopls": {...}}` | `"lsp": {"gopls": {"command": [gopls], "extensions": [".go"]}}` | With an object, every built-in LSP is enabled and the named one is overridden (`packages/opencode/src/lsp/lsp.ts:151-183`). Only `.go`/`.md` files are touched, so only gopls spawns. |
| `@internetisalie/opencode-pty-bridge@0.1.0` | GitHub Packages | built from `internetisalie/opencode-pty-bridge` tag `v0.1.0` (`tsc`), with its dep `@internetisalie/opencode-pty@0.4.1` built from tag `v0.4.1` | Not on the public registry. `opencode-pty@0.4.1` pins `bun-pty@0.4.10`. |
| `opencode-plugin-simple-memory` | local plugin | **no-op stand-in** (`export default { id, server() { return {} } }`) | Not obtainable. |
| `opencode-openai-codex-auth` | as configured | `@4.4.0` from npm, installed by opencode itself | |
| `@khalilgharbaoui/opencode-claude-code-plugin@0.36.4` | with two local patches | upstream 0.36.4 from npm, installed by opencode | The local patches are not available. |
| `claude` CLI | logged in | **not on PATH** (a logged-in `claude` exists in this sandbox at `/opt/node22/bin`; every server ran with an explicit PATH excluding it) | No real credentials anywhere. Sessions through the `claude-code` provider were **not run** (they need the CLI and a login). That provider is configured and loaded only. |
| Providers | 5 entries | `claude-code` (18 models), `corp-a` and `corp-b` (OpenAI-compatible, 40 and 30 models), `openai` (25) and `openrouter` (35), all with `baseURL` = the stub | Sessions always run on `stub/stub-coder`, so only the configs' size is tested. |
| `.opencode/` | ~25 skills, ~8 agents, AGENTS.md ~10 KB | 25 `skills/<n>/SKILL.md` (5–40 KB of generated prose), 8 `agents/*.md`, a 10 KB `AGENTS.md` at the project root | Content is synthetic. AGENTS.md is placed where opencode reads it. |
| Session script | real agents | each session makes 9 tool calls: bash ×3, read ×3, grep, write + edit of a new `.go` file so gopls runs diagnostics. When the PTY plugin is loaded it also runs `pty_spawn` of a 1 s `bash -c`, then `pty_read` (12 calls). | The agent uses the plugin's tools when they exist, as production agents do. |
| Event-stream clients | TUI seats | none, except in the Q8 run (2 × `/global/event` per directory, which is what the TUI holds: `packages/tui/src/context/sdk.tsx:91`) | |

Run notes:

- `curl` to `models.dev` was not used. The catalog came from the official `opencode-linux-x64@1.18.32` npm binary, as in spike 1.
- My no-web-UI build forwards non-API routes to `https://app.opencode.ai` (`packages/opencode/src/server/shared/ui.ts:9`). One such request happened during a Q7 run and was **refused by the sandbox proxy**. I couldn't identify which client sent it. Release builds embed the UI.
- The sandbox disk filled once (20:28–20:34 UTC) because of the Q7 DB bloat described below. Three Q9 soak sessions (29–31) failed in that window, and the T+90 min heap dump was lost. The soak recovered unaided.
- **Patch provenance.** Bun installs package files as hardlinks to its global cache. Patching `bun-pty` in place therefore changed one shared inode.
  - Here that inode was the plugin's `bun-pty@0.4.10` (opencode-pty build, original bridge and bun's cache), patched at 19:50:01 UTC.
  - Runs whose server loaded the plugin **before** that time ran the unpatched plugin, and their ptmx growth confirms it: q5plugins, q6 fixes-on, q6 fixes-off, the Q9 soak.
  - q6on2 (19:53) ran it patched, as intended. q8sse and the Q7 runs (after 19:50) also ran it patched; neither question depends on PTYs.
  - Spike 1's in-place patch of opencode's own `bun-pty@0.4.8` had the same side effect on bun's cache. Its baseline builds were made with the original file restored, which was verified in the binaries.
  - Both cache files were restored to the original afterwards.
- One Q7 run was contaminated by a surviving driver from an aborted attempt. It was discarded (kept as `q7patch-contaminated` locally, not used) and re-run.

## Q5: which production feature costs the missing ~120 MiB per directory?

Protocol as in spike 1: 20 fresh directories, one session each, `active` / `idle` (120 s) / `postgc` (SIGUSR2 + `Bun.gc(true)`) at N=1, 5, 10 and 20. Unmodified build (`instr-v2`). Slopes are N=1 → N=20, post-GC, divided by 19.

| run | N=1 RSS | N=20 RSS | **server RSS/dir** | heap live/dir | heap cap/dir | objects/dir | mimalloc/dir | threads/dir | **children RSS/dir** | **process tree/dir** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base (catalog only, Go repo) | 482 | 1210 | **38.3** | 26.8 | 34.1 | 485 k | 0.0 | 3.0 | 0 | 38.3 |
| + `.opencode/` | 531 | 1291 | **40.0** | 27.8 | 34.4 | 486 k | 1.1 | 3.0 | 0 | 40.0 |
| + LSP (gopls) | 481 | 1209 | **38.3** | 26.9 | 34.4 | 486 k | 0.0 | 3.0 | **116–158** | **154.7** |
| + plugins | 566 | 1214 | **34.1** | 26.8 | 29.9 | 487 k | 0.1 | 5.0 | 0 | 34.1 |
| + large provider configs | 480 | 1212 | **38.5** | 27.2 | 34.7 | 492 k | 0.0 | 3.0 | 0 | 38.5 |
| **all four** (= Q6 off) | 577 | 1337 | **40.0** | 28.5 | 35.1 | 495 k | 1.4 | 5.0 | **109–150** | **148.7** |

All values are MiB, except heap (MB) and objects. Post-GC RSS noise between checkpoints is about ±4 MiB/dir. gopls's per-dir figure depends on timing: 116 MiB at the N=1→N=20 post-GC points, 158 MiB per gopls at N=20 idle (3,162 MiB for 20).

**Attribution.**

- **LSP.** A gopls child per directory (`packages/opencode/src/lsp/server.ts:359-389`, spawned on the first `.go` touch). Its client sits in the v1 LSP `InstanceState` (`packages/opencode/src/lsp/lsp.ts:145`), which is shut down only by instance disposal (`lsp.ts:198` finalizer).
  - Without a dispose path, every gopls lives forever. 20 gopls = 3.0–3.3 GiB at N=20.
  - Server-side cost of the LSP client is ~0 MiB/dir.
  - **This is the only feature whose cost is in the 0.16 GiB/dir range, and it is outside the server process.** Production's figure came from a sampler over the server's `/proc/<pid>`. If that was VmRSS of the server PID only, it would not include gopls and this rig does not reproduce it. If it was the process tree or cgroup, gopls accounts for it. I could not tell which from the spike text.
- **`.opencode/`.** +1.7 MiB/dir (within noise), plus +49 MiB once at N=1. Owners:
  - skills, agents and commands are loaded into v1 `InstanceState`s (`skill/index.ts`, `agent/agent.ts`, `command/index.ts`)
  - every directory's `.opencode/` gets an in-process arborist install of `@opencode-ai/plugin` (`packages/opencode/src/config/config.ts:450-470`), which explains the 28–56 transient npm sockets in Q8
- **Plugins.** No per-dir heap cost. The N=1 cost is +84 MiB once (plugin modules loaded once per process). **+2 threads and 3 ptmx + 1 pts per session**: each session's `pty_spawn` leaks one PTY (Q6).
- **Provider configs.** +0.2 MiB/dir, within noise. The 160-model configs are dwarfed by the 7,954-model catalog copy that spike 1 found in every directory (`packages/opencode/src/provider/provider.ts:1400-1406`).
- **Server-side 38–40 MiB/dir in every run** is spike 1's catalog copy (v1 `Provider` state and v2 location `Catalog`). The object deltas are unchanged at ~486 k/dir.

## Q6: do the two fixes release it?

All four features, same protocol, plus R2/R3 revisits of p1–p20. Fixes off = `instr-v2`. Fixes on = `proto-v2` with `OPENCODE_INSTANCE_IDLE_TTL_MS=60000`. A third run also applies the same close-on-exit patch to **the plugin's own** `bun-pty@0.4.10`.

| run | step | server RSS (post-GC) | heap live / cap MB | objects | threads | ptmx / pts | inotify | gopls (RSS) | process tree |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| fixes off | N=1 | 577 | 224 / 363 | 2.42 M | 21 | 3 / 1 | 2 | 1 (953) | 1,530 |
| | N=20 | 1,337 | 766 / 1030 | 11.83 M | 116 | 60 / 20 | 21 | 20 (3,016) | 4,353 |
| | R2 | 1,362 | 771 / 1036 | 11.83 M | 156 | 120 / 40 | 21 | 20 (2,662) | 4,024 |
| | R3 | **1,359** | 772 / 1037 | 11.84 M | **196** | **180 / 60** | 21 | 20 (2,623) | **3,982** |
| fixes on (opencode side) | N=1 | 435 | 195 / 246 | 1.92 M | 16 | 3 / 1 | 0 | 0 | 435 |
| | N=20 | 524 | 218 / 278 | 1.94 M | 54 | 60 / 20 | 0 | 0 | 524 |
| | R2 | 567 | 223 / 289 | 1.95 M | 94 | 120 / 40 | 0 | 0 | 567 |
| | R3 | **582** | 223 / 289 | 1.95 M | **134** | **180 / 60** | 0 | 0 | **582** |
| fixes on + plugin `bun-pty` patched | N=1 | 452 | 195 / 257 | 1.92 M | 14 | 0 / 0 | 0 | 0 | 452 |
| | N=20 | 512 | 218 / 287 | 1.94 M | 14 | 0 / 0 | 0 | 0 | 512 |
| | R2 | 536 | 221 / 293 | 1.94 M | 14 | 0 / 0 | 0 | 0 | 536 |
| | R3 | **542** | 221 / 296 | 1.95 M | **14** | **0 / 0** | 0 | 0 | **542** |

- **The idle sweeper releases the per-directory server cost and the gopls children.** The JS heap is flat across 60 directory lifecycles (195 → 223 MB live, ~1.94 M objects). Every gopls is shut down when its instance is disposed (the LSP `InstanceState` finalizer). At R3 the process tree is 582 MiB instead of 3,982 MiB.
- **The opencode-side `bun-pty` patch does not touch production's PTY leak.** The leaked PTYs come from the pty plugin's `pty_spawn` tool, and the plugin loads **its own** `bun-pty@0.4.10` (`opencode-pty/package.json` → `"bun-pty": "^0.4.10"`). It has the same child-exit branch with no `bun_pty_close`.
  - The plugin's lifecycle also never closes an exited PTY: `kill(id, cleanup)` calls `process.kill()` only while `status === 'running'` (`opencode-pty` v0.4.1 `src/plugin/pty/session-lifecycle.ts:161-168`). The `onExit` handler only records the status (`:123-137`). Cleanup happens only on `session.deleted` (`src/plugin.ts:68-70` → `cleanupBySession`, `session-lifecycle.ts:188-194`).
  - The bridge's per-PTY `OutputStore` map (`opencode-pty-bridge` v0.1.0 `src/index.ts:19`, ≤512 KB each, `src/output-store.ts:1`) is never pruned. That last point comes from reading the code; it wasn't measured separately.
  - Patching the plugin's `bun-pty` copy (the same 3 lines as `bun-pty-close-on-exit.diff`) takes ptmx/pts to 0 and threads to 14.
- Remaining growth with all fixes: post-GC RSS 452 → 542 MiB over 60 lifecycles, with the JS heap flat. mimalloc committed rises 200 → 241 MB (+41 MB), the only component still growing. Not investigated further.

## Q7: what produces multi-GB bursts?

All four features on, fixes off, 1 s sampler of VmRSS / VmHWM / anon. Scripts:
- `bigedit`: 5 MB bash output, read of a 50k-line file, then `edit` that rewrites every line of a 100k-line (8 MB) file.
- `bigpatch`: the same first two steps, then `apply_patch` deleting the 100k-line file and adding a new 100k-line file (gpt-* model, so `apply_patch` replaces `edit`/`write`: `packages/opencode/src/tool/registry.ts:297-300`).
- `histbig`: a long session of N turns, each `write`-ing a new 1 MB file.

| run | peak RSS | VmHWM | idle 120 s (no GC) | post-GC | notes |
|---|---:|---:|---:|---:|---|
| `bigpatch`, 1 session × 3 dirs | 1.18–1.43 GiB | 1.46 GiB | 0.68–0.77 GiB | 0.65–0.76 GiB | Per step: new-directory instance boot ≈ +570 MiB before the first tool; 5 MB bash ≈ +100 MiB; 7.8 MB `apply_patch` add ≈ +250 MiB peak; 50k-line read ≈ 0 (output capped at 50 KB) |
| `bigpatch`, **8 concurrent** sessions on 8 fresh dirs | **1.86 GiB** | 1.94 GiB | 1.02 GiB | 0.98 GiB | fall to idle −45% |
| `bigedit`, 1 session | 1.75 GiB after 22 min, still rising | 1.76 GiB | — | — | **event loop blocked at 100% CPU for >20 min; server unresponsive to all HTTP**; killed |
| `histbig`, 40 turns × 1 MB | 1.64 GiB | 1.67 GiB | 0.74 GiB | 0.70 GiB | |
| `histbig`, **120 turns × 1 MB** | **2.78 GiB** | **2.93 GiB** | 0.87 GiB | 0.74 GiB | step gap 0.5 s → 5–7 s; **DB grew to 6.2 GB** |
| `histbig`, 120 turns, `"snapshot": false` | **1.58 GiB** | **1.58 GiB** | 0.68 GiB | 0.64 GiB | ablation of the summary diff: step gap 0.1 → 1.3 s, DB **0.29 GB**, 259 s vs 476 s |

**Mechanisms found.**

1. **Per-step session summary diff, unbounded and re-persisted every step: the multi-GB driver.**
   - After every model step, `packages/opencode/src/session/processor.ts:496-501` forks `SessionSummary.summarize`.
   - That reloads all messages and calls `snapshot.diffFull(firstSnapshot, current)` (`packages/opencode/src/session/summary.ts:116-124`).
   - `diffFull` reads the before/after contents of **every file changed since the turn began**. It builds a patch per file with `structuredPatch(..., { context: Number.MAX_SAFE_INTEGER })`, i.e. full-file context with no size bound (`packages/opencode/src/snapshot/index.ts:737`, used at `:748`).
   - It stores the array on the user message (`summary.ts:125-126`). That publishes a durable `message.updated` event whose payload is the whole message, diffs included.
   - In the 120-turn run the `event` table held **486 `message.updated.1` events totalling 5,812 MB**. The 120 large ones grew linearly, 1, 2, 3 … 97 MB (each holds every file diff so far), so the cost is quadratic in disk and per-step memory.
   - Bursts follow: at step *i* the server holds *i* MB of file contents, a full-context patch per file, the message JSON and the event JSON.
   - Production's "247 MB `apply_patch` deletion diff" and "diffs of several thousand lines" sit on this path.
   - **Ablation** (`"snapshot": false` makes `summarize` return early, `summary.ts:115`; history replay unchanged): peak 2.93 → 1.58 GiB HWM, DB 6.2 → 0.29 GB, run time 476 → 259 s. **The summary diff is ~1.35 GiB of the 2.93 GiB peak (~60% of the burst above idle) and ~95% of the DB growth.**
2. **`edit` on a large, heavily changed file blocks the event loop for hours.**
   - `edit` computes `createTwoFilesPatch` twice and `diffLines` once on the whole file, unbounded (`packages/opencode/src/tool/edit.ts:137-147, 164-171, 177-180`).
   - With every line changed, Myers diff is ~quadratic. A micro-benchmark of the same `diff@8.0.2` call: 1k lines 0.45 s, 2k 1.5 s, 4k 6.5 s, 8k 28 s, so 100k ≈ **73 min per call**, ~3.5 h for one `edit`.
   - The whole server is unresponsive meanwhile, and RSS rose 1.41 → 1.75 GiB in 20 min.
   - `apply_patch` already bounds its stored diff (`boundedPatch`, `edit.ts:716-719`, 512 K-char cut-off; a deletion stores only a header, `apply_patch.ts:179-181`). It still runs an unbounded `diffLines` for its line counts (`apply_patch.ts:86, 137`).
3. **History replay.**
   - Tool **inputs** (`write` content, `edit` strings, patch text) are not truncated the way outputs are (`tool/truncate.ts`, 50 KB/2,000 lines). Every step re-sends the whole history.
   - With summaries off, step gaps still grew 0.1 s → 1.3 s over 120 turns of 1 MB inputs, and the burst still reached 1.58 GiB (~0.9 GiB over idle). That remainder is the history replay.

**Shape.** Bursts of +1–2.5 GiB over the idle baseline, falling by 45–70% at idle without a GC. The retained remainder is the per-directory instance cost from Q5. The production shape (a jump of several GB that falls back only ~⅓) is consistent with mechanism 1, given production's longer sessions and larger diffs. **I did not reproduce a burst above 3 GiB**; production's 7.4 GB VmHWM was not reached.

## Q8: where do ~225 sockets come from?

All four features, fixes off. Every socket fd classified by `/proc/net/{tcp,tcp6,unix}` plus `lsof +E` peers. With no event-stream clients (`q6off`, 20 dirs) and with 2 × `/global/event` per directory (`q8sse`, 10 dirs):

| class | owner | count |
|---|---|---|
| `unix` socketpair ↔ `gopls` | LSP child stdio (Bun spawns over socketpairs) | **3 per directory with gopls** (60 at N=20), never released without dispose |
| TCP `inbound-client` | each `/global/event` (TUI) subscriber, plus the driver's in-flight request | **1 per subscriber** (21 at 10 dirs × 2) |
| TCP → `registry.npmjs.org` (104.16.x.x:443) | in-process arborist installs: plugins at boot and `@opencode-ai/plugin` into each `.opencode/` (`config.ts:450-470`) | 28 at first load, 56 with plugins + `.opencode/`; **transient**, back to 1–3 within minutes |
| TCP → stub provider | AI SDK keep-alive | 1–2 |
| TCP loopback to the server's own port | plugin SDK client (`client.session.*`) | 1 |
| TCP LISTEN | the server | 1 |

Active, idle and post-GC show the same composition. Only the npm keep-alives decay, so GC has no effect on sockets.

**Extrapolated to production** (estimates, not measured):
- 33 directories with gopls: 99
- TUI clients: 1 each
- the `claude-code` provider's `claude` CLI children: likely 3 socketpairs each, up to 16 by the plugin's own cap = ≤48 (not measured, since no CLI and no login here)
- npm bursts: 28–56

That totals ~200–250 with a few dozen TUI clients. **I couldn't measure** production's TUI-client count or the `claude` children's sockets.

## Q9: growth with time, 6 h soak

Setup:
- 8 directories (p1–p8) in rotation, one new session every 3 min. Every 4th session is "long" (~57 tool calls); the others make 12, including the pty plugin's `pty_spawn` + `pty_read`.
- All four features on. opencode-side fixes on (`proto-v2`, `OPENCODE_INSTANCE_IDLE_TTL_MS=60000`). The plugin's `bun-pty` was **unpatched** (it loaded before 19:50, see section 0).
- 1-minute `/proc` ticks (`runs/q9soak/timeline.jsonl`), plus a post-GC heap dump every 30 min.

**Planned 6 h; ran 1.95 h (19:04–21:01 UTC, 40 sessions), then the sandbox container restarted and took every process with it.**
- Sessions 29–31 failed in the disk-full window (20:28–20:34), and the T+90 min heap dump was lost to it.
- I did not restart the soak, so there is no data past 2 h.

| dump | post-GC RSS | heap live / cap MB | objects | mimalloc MB | threads | ptmx / pts | sockets | gopls |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| T0 (boot) | 276 | 108 / 149 | 1.68 M | 47 | 11 | 0 / 0 | 1 | — |
| T+30 min | 644 | 250 / 397 | 2.46 M | 207 | 44 | 33 / 11 | 7 | 1 (121 MiB, active dir) |
| T+60 min | 652 | 251 / 414 | 2.46 M | 212 | 63 | 63 / 21 | 7 | 1 (114 MiB, active dir) |
| T+90 min (no heap dump, disk full) | 495 | — | — | — | 68 | 84 / 28 | 1 | 0 (all dirs idle > TTL) |
| last tick T+117 min (not GC'd) | 679 | — | — | — | 94 | 111 / 37 | 10 | 1 |

Linear fits over the 1-minute ticks, excluding the first 10 min:

| quantity | slope |
|---|---:|
| RSS | **−11 MiB/h** (flat: ticks stay 650–700 MiB with an active directory, ~495 MiB with none) |
| threads | **+38 /h** |
| ptmx | **+54 /h** |
| pts | **+18 /h** |

- **With the opencode fixes on, memory does not grow with time** over 2 h and 40 sessions on 8 rotating directories.
  - Between T+30 and T+60 the JS heap (250 → 251 MB live) and object count (2.46 M) are flat.
  - Each directory's instance and gopls are created when it is used and disposed 60 s after it goes idle. With all directories idle (T+90) the process tree drops to the server alone.
- **The one resource that grows with time is the pty plugin's leak:** ~1 pts + 3 ptmx + ~2 threads per session that calls `pty_spawn`, never released while the session exists (section Q6).
  - At production's session rate it alone would explain the 3:1 ptmx:pts fds and the thread count rising with uptime. It costs little RSS (~0.1 MiB per PTY here). The cost is fds and native threads.
- **Not established:** whether anything grows slowly over hours beyond 2 h, or with the fixes **off**. Q6's R2/R3 revisits (fixes off) showed post-GC RSS flat on revisits of the same 20 directories (1,337 → 1,362 → 1,359 MiB), so growth with fixes off tracks *new* directories, not time.

## What I could not establish

- **Whether production's 0.16 GiB/dir is server-only or process-tree.** The server-only cost here is 38–40 MiB/dir with every feature. The tree cost with gopls is ~150 MiB/dir. If production's sampler read only the server PID's VmRSS, something not reproduced here costs ~120 MiB/dir server-side. Candidates I could not exercise: `claude-code` provider sessions, the two local claude-code patches, simple-memory, real session histories loaded per directory.
- **Multi-GB bursts above 3 GiB.** The mechanism (Q7.1) scales without bound, but I stopped at 120 turns × 1 MB because of disk (one 6.2 GB DB).
- **The `claude-code` provider's runtime cost** (CLI children, stream buffers): it needs the CLI and real credentials, so I stopped that part of the question rather than approximate it.
- **The real simple-memory plugin and the claude-code plugin's local patches:** not available.
- **gopls memory on production repos:** measured on `golang/vuln` (≈150–160 MiB per instance idle). It would differ with repo size and dependency count.
- **The memory share of history replay vs summary diffs** comes from a single ablation pair (one run each), not repeated.
