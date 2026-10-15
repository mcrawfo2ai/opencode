# Spike: where does opencode 1.18.32's server memory go?

**Summary.** Most of the per-directory growth is in the JS heap. Each directory gets its own copies of the models.dev provider catalog, built when its first prompt runs. One set of copies lives in v1 instance state and is never freed; the other lives in v2 location services and is freed after 60 minutes idle. The `ptmx`/`pts` leak is real and has a 3-line fix in `bun-pty`. A prototype that disposes idle instances brings RSS back near the one-directory level.

I measured ~37 MiB per directory, not 0.16 GiB. Production has things my setup lacks, listed in §6.

## 1. Environment

| | |
|---|---|
| OS | Ubuntu 24.04.5 LTS, Linux 6.18.44 VM, 4 vCPU, 16 GB RAM, no swap |
| bun | **1.3.14**, the repo's `packageManager` pin, taken from npm `@oven/bun-linux-x64@1.3.14`. The sandbox default was 1.4.2 and was not used. |
| Code | `internetisalie/opencode` tag `v1.18.32-internetisalie.3` = `f7f6c22da0595bc571a3445d309a26706259b644` |
| Build | `packages/opencode`: `bun run script/build.ts --single --skip-install --skip-embed-web-ui` with `OPENCODE_VERSION=1.18.32`. This gives a compiled `opencode-linux-x64` binary. |
| Server | `opencode serve --hostname 127.0.0.1 --port <p> --print-logs`, with a fresh `HOME`/XDG tree per run |

**Build deviations (all forced by the sandbox):**
- `ghostty-web` (a `github:` tarball dependency) got a 403. I cloned it at the pinned commit `83c0a07` and pointed to it with `file:`.
- `@solidjs/start` from pkg.pr.new was blocked. It is web-UI only, so the web UI is not embedded.
- **models.dev catalog.** The build fetches `https://models.dev/api.json`. In the sandbox the proxy refused it, so my first build embedded garbage. That first build is the one outbound attempt to a host outside the allowed list; it was refused. I then extracted the catalog that the official `opencode-linux-x64@1.18.32` npm binary embeds (223 providers, 7,954 models). I parsed it with JSON5, no eval, and fed it in via `MODELS_DEV_API_JSON`. This matters: the catalog turned out to be the main per-directory cost (§3). I also kept an empty-catalog build as an ablation.
- The sandbox shell injects `BUN_OPTIONS=--smol` and `BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE=1`. Both were **unset** for every server.

**Throwaway instrument.** `packages/opencode/src/cli/memdump.ts` adds a SIGUSR2 handler. It runs `Bun.gc(true)` ×2, then dumps `process.memoryUsage()`, `bun:jsc` `heapStats()` (heap size and capacity, object-type counts) and `heapStats().mimalloc` (Bun's native allocator). It has no effect until signalled.

**How the server was driven (provider-free).**
- A localhost stub OpenAI-compatible server is configured as provider `stub` via `@ai-sdk/openai-compatible`. It scripts tool calls.
- Each session: `POST /session?directory=D`, then a synchronous `POST /session/:id/message`.
- The model makes **7 tool calls**: bash `ls/git status`, read `src/index.ts`, bash `find|xargs wc -l`, read `README.md`, grep `function`, bash loop + `sleep 1`, read `src/util.py`. Then it replies with text and the session goes idle.
- Every session in every run completed 7/7 tools.
- Projects are distinct git repos:
  - "small": 205 files
  - "big": 3,398 files, a slice of the opencode tree with a distinct root commit
- Defaults that matter: LSP is **off** (no `lsp` key, so "all LSPs are disabled", `packages/opencode/src/lsp/lsp.ts:151`). No MCP servers, no project `.opencode/` dirs.

**Sampler.** `/proc/PID/status` (VmRSS, VmHWM, Threads) and `smaps_rollup` (Anonymous), fd classes from `readlink /proc/PID/fd/*`, inotify watches from `fdinfo`.

**Q1 protocol.** Boot, idle 120 s, then for N = 1…20 one session in fresh directory `pN`.
- At N ∈ {1, 5, 10, 20}, three snapshots are taken:
  - `active`: right after the session
  - `idle`: after 120 s with no requests
  - `postgc`: after SIGUSR2 (full GC)

## 2. Q1: per-directory cost

### Main run: real models.dev catalog, small repos, unmodified build (`q1real`)

| step | RSS MiB | anon MiB | threads | ptmx | pts | inotify fds (watches) | eventpoll | socket |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| N=0 idle | 288 | 229 | 8 | 0 | 0 | 0 (0) | 1 | 1 |
| N=0 postgc | 277 | 218 | 9 | 0 | 0 | 0 (0) | 1 | 1 |
| N=1 active | 661 | 581 | 24 | 0 | 0 | 2 (6) | 3 | 3 |
| N=1 idle | 496 | 415 | 17 | 0 | 0 | 2 (6) | 3 | 30 |
| N=1 postgc | 470 | 389 | 19 | 0 | 0 | 2 (6) | 3 | 30 |
| N=5 active | 777 | 697 | 35 | 0 | 0 | 6 (30) | 7 | 30 |
| N=5 idle | 697 | 617 | 29 | 0 | 0 | 6 (30) | 7 | 30 |
| N=5 postgc | 665 | 585 | 31 | 0 | 0 | 6 (30) | 7 | 30 |
| N=10 active | 931 | 851 | 49 | 0 | 0 | 11 (60) | 12 | 30 |
| N=10 idle | 862 | 781 | 44 | 0 | 0 | 11 (60) | 12 | 2 |
| N=10 postgc | 839 | 759 | 46 | 0 | 0 | 11 (60) | 12 | 2 |
| N=20 active | 1399 | 1319 | 79 | 0 | 0 | 21 (120) | 22 | 2 |
| N=20 idle | 1225 | 1145 | 77 | 0 | 0 | 21 (120) | 22 | 2 |
| N=20 postgc | 1172 | 1092 | 76 | 0 | 0 | 21 (120) | 22 | 2 |
| +6 min idle, 2× GC +30 s | 1172 | 1091 | 74 | 0 | 0 | 21 (120) | 22 | 1 |
| +60 min idle | 1173 | 1092 | 12 | 0 | 0 | 0 (0) | 2 | 1 |
| +60 min idle, postgc | 995 | 914 | 12 | 0 | 0 | 0 (0) | 2 | 1 |

### Per-directory increment (N=1 → N=20, slope over 19 directories)

| run | post-GC RSS per dir | active RSS per dir | threads per dir |
|---|---:|---:|---:|
| **real catalog, small repos (`q1real`)** | **36.9 MiB** | 38.8 MiB | +3 |
| empty catalog, small repos (`q1a`) | 4.4 MiB (366 → 449) | 4.7 MiB | +3 |
| empty catalog, 3.4k-file repos (`q1big`) | 4.8 MiB (392 → 483) | 8.3 MiB | +3, watches 272/dir |
| control: 20 sessions in **one** dir, empty catalog | ≈0 (368 → 409, flat after N=1) | — | 0 |
| instance load only (GET session/config/agent, no prompt), real catalog | ≈0 (333 → 323) | — | 0 |

**Is it ~0.16 GiB/dir?** No. Here it is ~37 MiB/dir, about 4.3× less (see §6). It is per *directory*, not per session: the same-dir control is flat. The catalog copies are built on the first prompt in a directory, not on instance load.

**Is any of it released on idle?**
- Not within minutes. At N=20, 2 min idle took RSS from 1399 to 1225 MiB. Forced GC took it to 1172. That is only the per-session transient; it stays at 1172 after repeated GCs.
- After **60 min** idle, the v2 location-service TTL fires:
  - threads 74 → 12, inotify fds 21 → 0
  - JS heap 723 → 524 MB
  - post-GC RSS 1172 → 995 MiB
- Nothing else is ever released.
- Without a GC, RSS doesn't move at all (1173 MiB at +60 min). JSC does not collect in an idle process.

## 3. Q2: what holds it

### Breakdown, `q1real` N=1 → N=20, post-GC (from `heapStats()` / `process.memoryUsage()` / `/proc`)

| component | N=1 | N=20 | Δ total | Δ per dir |
|---|---:|---:|---:|---:|
| RSS (sampler) | 470 MiB | 1172 MiB | +702 | **+36.9** |
| JSC heap, live (`heapSize`) | 216 MB | 723 MB | +507 | **+26.7** |
| JSC heap capacity (`heapCapacity`) | 310 MB | 941 MB | +631 | **+33.2** |
| JS objects | 2.37 M | 11.59 M | +9.2 M | +486 k |
| external / ArrayBuffer (`extraMemorySize`) | 81 MB | 109 MB | +28 | +1.5 |
| mimalloc committed (Bun native allocator) | 154 MB | 154 MB | 0 | 0 |
| threads | 19 | 76 | +57 | +3 (fff) |
| inotify fds / eventpoll fds | 2 / 3 | 21 / 22 | +19 / +19 | +1 / +1 |
| SQLite (file fds; one DB, `cache_size=-64000`) | 15–16 | 15–16 | 0 | 0 |
| child processes (LSP/MCP) | 0 | 0 | 0 | 0 |

Object-type deltas per directory (N=1 → N=5): +314,569 `Object`, +58,616 `string`, +35,495 `Array`, +18,316 butterflies. That is the shape of copying a 7,954-model catalog.

### Ranking

1. **Per-directory copies of the models.dev catalog (JS heap): ≈90% of the per-dir growth.**
   - Ablation: 36.9 MiB/dir with the real catalog vs 4.4 MiB/dir with an empty one.
   - Heap capacity accounts for 631 of the 702 MiB RSS delta.
   - Two owners:
     - **v1 `Provider` instance state, never released.** `packages/opencode/src/provider/provider.ts:1400-1406`, inside `InstanceState.make` (one cache entry per directory):
       - `const catalog = mapValues(modelsDev, fromModelsDevProvider)` and `const database = mapValues(catalog, toPublicInfo)`
       - `catalog` is kept in state (`:1724`); `database` is used to build `providers`.
       - It is created lazily on the first `getModel`, i.e. the first prompt. That is why instance-only loads cost ≈0.
     - **v2 location-scoped `Catalog`, freed after 60 min idle.** Filled per location by `ModelsDevPlugin` (`packages/core/src/plugin/models-dev.ts:119-164`). It is built because `SystemPrompt.environment` calls `locations.get(dir)` on every LLM step (`packages/opencode/src/session/system.ts:66-73`). That builds the directory's full v2 location-service graph.
   - Split, measured at the 60-minute expiry:
     - v2: −199 MB heap and −3.78 M objects for 20 dirs, ≈10 MB/dir
     - v1: what remains above N=1 is 308 MB / 19 dirs, ≈16 MB/dir live
2. **`fff` file finder, one per directory (native), in the v2 location services: 3 threads + 1 inotify + 1 epoll fd per directory.**
   - Thread names: 20× each of `notify-rs inotify`, `notify-rs debounce`, `fff-watcher-owner` for 20 dirs.
   - Watches equal the number of directories in the repo: 6 for small repos, 272 for 3.4k-file repos.
   - Its memory is small. With fff disabled (`OPENCODE_DISABLE_FFF=1`, big repos) there are no per-dir threads or inotify fds, and RSS growth is about the same as with fff on.
   - Owner: `packages/core/src/filesystem/search.ts:122-147`, held by the `LocationServiceMap` entry for 60 min (`packages/core/src/location-services.ts:109`).
   - This matches production's thread growth: (157 − 50) / 33 dirs ≈ 3.2 threads/dir.
3. **Everything else per directory (v1 instance state minus provider, tool/agent/config state):** ≈4 MiB/dir. This is the empty-catalog slope. Its JS part is ~2.4 MB/dir live (185 → 230 MB over 20 dirs).
4. **Not per directory:**
   - SQLite: one connection, flat fds, ≤64 MB cache by config, `packages/core/src/database/database.ts:30`.
   - mimalloc: flat after the first session.
   - LSP: off by default, not exercised.
   - Sockets: the ~28 TCP sockets are keep-alives to registry.npmjs.org. They come from the in-process arborist install of `@opencode-ai/plugin` into the config dir on the first instance (`packages/opencode/src/config/config.ts:450-470`), and drop to 1–2 after a few minutes.
   - Thread stacks: the 8 MiB stack-like mappings total <10 MiB RSS.
5. **Allocator slack / uncollected garbage (not a leak, but it makes RSS lag).**
   - With the prototype (§5), the JS heap returns to its N=1 value after each dispose. RSS stays high until a GC runs:
     - R2 idle: 1156 MiB, then 443 MiB after `Bun.gc(true)`
   - JSC GC is allocation-triggered and never runs in an idle server. This plausibly explains "growth falls back only partly".

**On finding 2 ("JS heap small relative to RSS").** I could not reproduce it: here heap capacity is 941 of 1172 MiB at N=20. A heap snapshot reports live object self-sizes. It does not count heap capacity, fragmentation, or garbage that no GC has collected yet, and an idle process never collects. Comparing `heapStats().heapCapacity` with RSS (both readable via an instrument like `memdump.ts`) would settle it on production.

## 4. Q3: PTY leak

**Yes, master fds stay open after the child exits, and nothing ever closes them.**

Minimal repro: fresh server, instance in `p1`, 10× `POST /pty?directory=p1 {"command":"/bin/sh","args":["-c","echo hello; sleep 6; exit 3"]}`. Script: `tools/ptyrepro.sh` in the scratchpad.

| step | unmodified: threads / ptmx / pts | with fix: threads / ptmx / pts |
|---|---|---|
| instance loaded, 0 PTY | 20 / 0 / 0 | 19 / 0 / 0 |
| 10 shells running | 50 / 30 / 10 | 50 / 30 / 10 |
| all 10 shells exited (no zombies, 0 children) | **40 / 30 / 10** | 20 / 0 / 0 |
| `DELETE /api/pty/:id` ×10 (all 404) | 43 / 30 / 10 | 23 / 0 / 0 |
| `POST /instance/dispose` | **38 / 30 / 10** | 18 / 0 / 0 |

Each leaked PTY holds **3 ptmx + 1 pts fds + 2 threads**. That is exactly production's 105 : 35 ratio, so production holds 35 leaked PTYs. The PTYs come from the terminal API (`/pty`), not the bash tool. The bash tool uses pipes via `ChildProcessSpawner` (`packages/opencode/src/tool/shell.ts:484`).

**Code path that should close them, and why it never runs.**

bun-pty 0.4.8:
- `bun_pty_close` (rust `lib.rs:379-381`) is the only call that removes a handle from the global `REG` map (`lib.rs:267`). Removal drops the `Pty`, which holds:
  - `_slave` (`lib.rs:151,180`): the **pts** fd
  - the master: **ptmx**
  - a reader dup (`try_clone_reader`, `lib.rs:206`): **ptmx**
  - a writer dup (`take_writer`, `lib.rs:223`): **ptmx**
- Because the process itself still holds the slave, the reader thread never sees EOF. The writer thread blocks on its channel. Those are the 2 threads.
- JS side (`src/terminal.ts`): `bun_pty_close` is called only from `kill()` (`:215-221`). The child-exit branch (`n === -2`, `:240-248`) fires `onExit` and breaks **without closing**.
- Upstream v0.5.1 has the same branch unchanged, so upgrading won't help.

opencode (`packages/core/src/pty.ts`):
- `onExit` sets `status = "exited"` (`:223-227`).
- `teardown()` only calls `process.kill()` if `status === "running"` (`:116-125`). After a natural exit, neither `remove`, the `EXITED_LIMIT=25` eviction (`:17, :233-237`) nor instance/location disposal closes the handle.

Also:
- The legacy routes hide exited sessions: `get` returns 404 for `status !== "running"` (`packages/opencode/src/server/routes/instance/httpapi/handlers/pty.ts:84-103`), so `DELETE /pty/:id` of an exited PTY is impossible (`:129-142`).
- `/api/pty` uses a different `LocationServiceMap` (`.../httpapi/server.ts:294`), so it can't see legacy-created PTYs either (all 404 above).
- Exited sessions also keep their JS output buffer, up to 2 M chars each (`BUFFER_LIMIT`, `:14`), until evicted. This is from reading the code only; I did not measure it.

**Fix used in the prototype** (bun-pty `src/terminal.ts`, child-exit branch). It belongs in `patches/` via `patchedDependencies`:

```diff
 				const exitCode = lib.symbols.bun_pty_get_exit_code(this.handle);
+				// Release the native handle: drops master/slave fds and lets the reader/writer threads exit.
+				this._closing = true;
+				lib.symbols.bun_pty_close(this.handle);
 				this._onExit.fire({ exitCode });
 				break;
```

It is verified in the right-hand column above.

## 5. Q4: instance lifetime

**Existing dispose paths:**
- **v1 `InstanceStore`** (`packages/opencode/src/project/instance-store.ts`): a `Map` with no TTL. Dispose happens only on explicit request:
  - `POST /instance/dispose` (`handlers/instance.ts:25`)
  - config update (`handlers/config.ts:20`)
  - project-directory dispose/reload (`handlers/project.ts:30,79,90`)
  - worktree removal (`worktree/index.ts:397,417`)
  - shutdown `disposeAll` (`server/global-lifecycle.ts:21`)
- Disposal runs the registered disposers. Only `InstanceState` caches (`effect/instance-state.ts:38`) and the PTY handlers' own location maps (`handlers/pty.ts:47,168`) register. The `LocationServiceMap`s used by `session/system.ts`, `agent/agent.ts` and `handlers/file.ts` are **not** invalidated, so even an explicit dispose leaves their fff and v2 catalog alive for up to 60 min.
- **v2 `LocationServiceMap`**: `idleTimeToLive: "60 minutes"` (`packages/core/src/location-services.ts:109`).
  - Measured: p1's fff was released at 16:09:46, after its last use at 15:09:42.
  - All per-dir threads and inotify fds were gone at +60 min. RSS fell 1172 → 995 MiB only after a forced GC.

**Smallest change:**
1. An idle sweeper in `InstanceStore`, behind `OPENCODE_INSTANCE_IDLE_TTL_MS`, default off. It tracks `lastUsed` and an in-flight `active` count per entry; the HTTP instance middleware wraps each request in `store.hold(dir, …)`.
2. Register the same location-map invalidation disposer that the PTY handlers already use in `system.ts`, `agent.ts` and `file.ts`.

About 60 added lines. Diff: `proto-instance-idle.diff` in the scratchpad; core of it:

```diff
+const IDLE_TTL_MS = Number(process.env.OPENCODE_INSTANCE_IDLE_TTL_MS ?? 0)
 interface Entry {
   readonly deferred: Deferred.Deferred<InstanceContext>
+  lastUsed: number
+  active: number
 }
 ...
+    const hold = (input, effect) => Effect.acquireUseRelease(
+      Effect.sync(() => { const e = cache.get(FSUtil.resolve(input)); if (e) e.active++; return e }),
+      () => effect,
+      (e) => Effect.sync(() => { if (!e) return; e.active--; e.lastUsed = Date.now() }))
+    const sweep = Effect.gen(function* () {
+      const now = Date.now()
+      for (const [directory, entry] of [...cache.entries()]) {
+        if (entry.active > 0 || now - entry.lastUsed < IDLE_TTL_MS) continue
+        if (!Deferred.isDoneUnsafe(entry.deferred)) continue
+        const exit = yield* Effect.exit(Deferred.await(entry.deferred))
+        if (Exit.isFailure(exit)) continue
+        yield* Effect.logInfo("idle-disposing instance", { directory, idleMs: now - entry.lastUsed })
+        yield* disposeEntry(directory, entry, exit.value)
+      }
+    })
+    if (IDLE_TTL_MS > 0) yield* sweep.pipe(Effect.catchCause(...), Effect.delay(...), Effect.forever, Effect.forkIn(scope))
--- middleware/instance-context.ts
-    return yield* effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, route.workspaceID))
+    return yield* store.hold(ctx.directory, effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, route.workspaceID)))
--- session/system.ts, agent/agent.ts, handlers/file.ts (same 4 lines each)
+    const unregisterLocation = registerDisposer((directory) =>
+      Effect.runPromise(locations.invalidate(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
+    yield* Effect.addFinalizer(() => Effect.sync(unregisterLocation))
```

### Q1 rerun with the prototype

Real catalog, small repos, `OPENCODE_INSTANCE_IDLE_TTL_MS=60000` (`q4real`). After the first 20 directories, R2 and R3 drive the same 20 directories again, which were already disposed. That is 60 instance lifecycles in total.

| step | RSS MiB | threads | inotify (watches) | vs unmodified |
|---|---:|---:|---:|---|
| N=1 postgc | 495 | 14 | 0 (0) | 470 |
| N=5 postgc | 638 | 14 | 0 (0) | 665 |
| N=10 postgc | 658 | 14 | 0 (0) | 839 |
| N=20 active | 947 | 49 | 11 (60) | 1399 |
| N=20 idle (sweeper ran, no GC) | 817 | 12 | 0 (0) | 1225 |
| **N=20 postgc** | **745** | **14** | **0 (0)** | **1172** |
| R2 active (20 dirs reloaded) | 1284 | 71 | 19 (108) | — |
| R2 idle (no GC) | 1156 | 9 | 0 (0) | — |
| **R2 postgc** | **443** | 14 | 0 (0) | — |
| **R3 postgc** | **457** | 14 | 0 (0) | — |

- JS heap after each sweep stays at its N=1 value: 189–194 MB live, ~1.89 M objects, from N=1 through R3. Unmodified: 216 → 723 MB.
- Post-GC RSS settles at **443–457 MiB after 60 directory lifecycles**, versus 1172 MiB unmodified after 20 and 995 MiB even after the 60-min v2 TTL.
- No errors in the server log.
- With the empty catalog (`q4a`): N=20 post-GC 440 vs 449 MiB, threads 14 vs 76, inotify 0 vs 21.

Caveats for productionizing:
- `hold` only covers work inside an HTTP request. `prompt_async` / background session runs need a busy check (e.g. `SessionStatus`) before a sweep disposes.
- A held-open `/event` SSE stream keeps an instance "active". That is arguably correct, but it can block disposal.
- RSS only drops after a GC (R2: 1156 before vs 443 after). It's worth calling `Bun.gc(true)` once after a sweep that disposed something.
- I didn't ablate the two prototype parts (instance dispose vs location invalidation) separately.

## 6. What I could not establish

- **The 0.16 GiB/dir magnitude.** I measured ~37 MiB/dir. Things production has that I didn't exercise:
  - configured or authenticated providers (more per-directory provider/SDK state)
  - LSP (off by default here)
  - MCP servers
  - project `.opencode/` dirs (each triggers an arborist install)
  - long sessions with large histories
  - plugins
  - real repo sizes
  - 11 h of uptime
- **Finding 2.** I had no production heap snapshot, and my measurements contradict "JS heap small". See the reconciliation note in §3.
- **7.4 GB VmHWM bursts.** The largest active-vs-idle spread here was ~+230 MiB (q1real at N=20: 1399 active vs 1172 post-GC).
- **~225 sockets.** I saw ≤30, all transient npm registry keep-alives. Production's are unexplained (client SSE/websocket? MCP? LSP?).
- **PTY output buffers retained in JS** for exited sessions: from reading the code only, not measured.
- **Node runtime path** (`pty.node.ts`, `@lydell/node-pty`): not tested. Neither was the web UI, which was not embedded.
- **Run length:** the longest run was ~1.5 h of server uptime. Production numbers are from 11 h and multi-day runs.

## Files in this directory

- `proto-instance-idle.diff`: the Q4 prototype (idle instance sweeper and location-map invalidation), against tag `v1.18.32-internetisalie.3`.
- `bun-pty-close-on-exit.diff`: the Q3 PTY fix, against `bun-pty@0.4.8` `src/terminal.ts`.
- `runs/*.jsonl`: one `/proc` snapshot per step for each run (`q1real` is the main Q1 run, `q4real` the prototype rerun, `q1a`/`q1big`/`q1same`/`abl-*`/`instonly` the ablations, `q4a` the empty-catalog prototype run). `tools/show.sh` or `tools/md.py` renders them.
- `tools/`: the throwaway harness. It has the stub OpenAI-compatible provider (`stub.ts`), the project generators (`setup*.sh`), the server launcher (`start.sh`) and the drivers (`drive*.sh`, `more.sh`), plus `ptyrepro.sh` for the PTY repro, `snap.sh` (the `/proc` sampler), the analyzers (`smaps.py`, `arenas.py`, `mem.py`) and the SIGUSR2 instrument (`memdump.ts`, wired into `packages/opencode/src/index.ts` next to `Heap.start()`). Set `S` to a scratch directory containing the built binary before using them.

The heap dumps, server logs and generated projects were not kept. Nothing here changes runtime code in this repository.
