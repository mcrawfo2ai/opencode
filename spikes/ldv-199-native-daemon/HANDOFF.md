# LDV-199 handoff: disposable native PTY daemon characterization spike

**Status: throwaway measurements + probe scripts. Not production code, not a design, not mergeable.**
Direct native-wire characterization only. This establishes **no** actual Core lifecycle, configured plugin load,
spawning-session bridge, UI selection or notification-admission behavior, and no production delivery. Nothing here
chooses an observer API. Any retained behavior must be rebuilt and independently reviewed (GPT seat).

## 1. Provenance

| Item | Value |
|---|---|
| forkURL | https://github.com/mcrawfo2ai/opencode (owner `mcrawfo2ai` = the cloud session's own GitHub login per `get_me`; push remote verified not `internetisalie`) |
| branch | `spike/ldv-199-native-daemon` |
| source pin | `591c6999ebceb86f1b4869685d87bc2e10d9a333` (the branch's parent; `git rev-parse HEAD` was this value before the spike commit) |
| head | the tip of the branch as pushed; reported to loom.manager out-of-band (a file cannot contain its own commit hash) |
| Claude identity | cloud session https://claude.ai/code/session_015Fcbv7BKM5xqYWTyJR8SKx. The serving model identifier is deliberately **not** written into repository artifacts (environment rule); it is reported in the chat report to loom.manager only. |
| Fork relationship | Not independently verified: no repo-metadata tool within scope. The repo contains the pinned commit and an `internetisalie-v2` branch. No write targeted internetisalie, no PR was created. |

## 2. Input and baseline ledgers

Read in full at the pin (byte counts verified with `wc -c`): `daemon.ts` 22587, `index.ts` 15007, `pty-binding.ts` 282,
`binary.bun.ts` 3159, `persistent-pty-daemon.test.ts` 10133 = **51168 bytes**, plus the complete brief (size not measured by me).
Baseline, counted separately: repository `AGENTS.md` 15361 bytes (loaded automatically).
Additional small public reads: the npm parent package `@opencode-ai/pty@0.1.13` (`index.js` 662 B, `bin/opencode-pty.js` 449 B,
`package.json`, to confirm how `binaryPath` resolves) and the platform package's `package.json`. No imported repo files were chased; the wire
declarations in `probe/lib.mjs` are local transcriptions of `daemon.ts` (protocol 7). **Unresolved dependencies, by design:** `effect`,
`@opencode/schema/persistent-pty` (`Handoff`, `Info` types), `@opencode/util/*`, `../shell/select`. No subagents were used.

Fake daemon tests (`persistent-pty-daemon.test.ts`) were read only for transport prior art; no fake outcome is used anywhere.

## 3. Native artifact, platform, tooling

- Package `@opencode-ai/pty-linux-x64-gnu@0.1.13` via `npm pack --ignore-scripts` (registry sha1 `99213b6d0d88a4e4ab28b639dbfb1ead7b3e0534`;
  tarball 1278488 B; sha512 integrity `sha512-jliNgsevGuxf…pzjhg==` matched the registry value; parent tarball sha256 `8d46a91b…f0d9`).
- Executable `bin/opencode-pty`: **3138672 bytes, SHA256 `b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa`** = the pin (verified at extraction
  and again on the private run copy `/tmp/r/bin/opencode-pty` immediately before launch). ELF 64-bit x86-64, dynamically linked glibc, stripped.
- Platform: Linux 6.18.44-fc-v51 x86_64, glibc 2.39 (Ubuntu), Node v22.22.0, Bun present but unused. Compatible with the artifact; nothing substituted from PATH. Not built, not modified.
- Boot id `6159cce6-ab5f-4c1e-b1a1-8a3079651ce2`, CLK_TCK 100, /proc start times recorded per daemon/fixture (`evidence/run.json`, `evidence/cleanup.json` `owned`).

## 4. Isolation and environment

- Wrapper `scratch-run.sh` (kept outside the repo, in `.spike-scratch/`, not committed): `unshare -m --propagation private`, bind-mounts the workspace
  scratch directory over `/tmp`, sets `TMPDIR/TMP/TEMP`, npm/bun/XDG cache variables into it. Verified: `/proc/self/mountinfo` shows
  `/home/user/opencode/.spike-scratch/tmp /tmp rw ext4 /dev/vda`, and a probe file written to `/tmp` landed in the workspace scratch (`evidence/run.json` `isolation`).
  Backing store is the disk-backed `/dev/vda`, not tmpfs. Host mounts/permissions untouched.
- The native daemon places its Unix socket at `/tmp/opencode-pty-0/<hash>.sock` (derived from the temp dir, **not** under `OPENCODE_PTY_RUNTIME_DIR`); under the bind that is inside scratch.
  `service.json` + `service.lock` live in the per-daemon runtime dir `/tmp/r/rt-<tag>/`.
- Daemon env allowlist (9 names): `HOME LANG OPENCODE_PTY_RUNTIME_DIR PATH TMPDIR XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR`. PTY-child env as seen by the fixture (`mode.env_keys` in case traces):
  those names plus `COLORTERM SHELL TERM`. **Observation:** the daemon merged its own env into the child (e.g. `OPENCODE_PTY_RUNTIME_DIR` appears in the child) and added `COLORTERM`/`SHELL`; no credential variable reached either. Child `HOME`/XDG point at `/tmp/r/home/...`; the agent's host `HOME` was never changed.
- The orchestrating Node process itself inherits the agent environment (166 variables; count only is recorded, names/values are not).

## 5. Launch contract as observed (not a guarantee)

`opencode-pty daemon` (detached, stdio ignored, allowlist env) wrote `service.json` {`instance_id`,`pid`,`protocol`,`socket`,`token`} within 57–66 ms. In all four daemons:
`protocol == 7`, `registration.pid == spawned pid`, `ping` returned `pong` with matching `instance_id/pid/protocol`, `/proc/<pid>/exe` == the verified copy.
`own {instance_id}` → `owned`. PTY ids returned by `create` are large integers (e.g. 949082360665224), not small counters.
Native instance is a Unix-socket service, not a TCP host; no port or server was invented.

## 6. Instruments (and why the matrix is interpretable)

- **Oracle**: each fixture writes the exact bytes it emits to the PTY into an oracle file via a separate path. Terminal mode is saved (`stty -g`) and set `-echo -opost`, verified from `stty -a` captured through a pipe (not PTY stdout);
  80x24 confirmed by the fixture (`mode.json`). **Origin** = native `output_tail` read while the *start* gate is still closed (no subscription needed); verified against the banner via replay-at-0 (`preOriginVerified: true`, cases 1/2/…).
  Native `[a,b)` is compared to `oracle[a-origin:b-origin]` only after bounds are checked (`end-start == payload length`, safe-integer offsets). Across all attaches, every compared byte matched; no first-difference was ever reported (`facts.json: byte_compare_mismatches_all_cases = []`).
- **Gates**: independent start / intermediate / exit gate files; fixture acks with fixture-side wall time. The exit gate is released only after (fixture ack of the intermediate output) **then** (a native `list` showing `running`). Ordering checker over all cases: `ordering_violations_all_cases = []`. Case 12 releases no exit gate because the prerequisite could not be met (see below).
- **Genuine-exit witness** is independent of native: fixture exit-stage ack + `/proc/<pid>` identity (start-time matched) gone/zombie, then native `list`, then native `exited` frame, all recorded as separate facts.
- **Negative controls**, built and passed offline *before* any native launch (`evidence/controls-synthetic.json`, 9/9) and re-run after the matrix against clones of captured native data (`evidence/controls-real.json`, 9/9): changed observed byte (reported exact offset 23, 205 vs oracle 50), shifted observed offset, inconsistent interval bounds, omitted intermediate ack, exit released before native-running, detach before owner-close, detach before property settled, substituted instance identity (reported `got`/`want`), raw exit code replaced by zero (7→0). Each detected the *specific* change, then restored green. **Limitation:** native never produced a `null` exit_code, so the "null→0" control ran on a synthetic null (instrument check) and on a real 7→0 mutation, not on a native null.
- Frame cap 8388608 enforced client-side (decoder rejects larger length headers and closes); validators (`probe/lib.mjs`) flag any response/frame that deviates from the pinned declarations — none did.

## 7. Case matrix

Outcome vocabulary: **observed** (instrument valid, outcome recorded), **adverse** (observed outcome is unfavorable to a consumer assuming continuity), **unknown**, **timed-out**, **blocked**, **not-reached**. Evidence is `evidence/case-NN.json` (sha256 in `MANIFEST.sha256`); a second independent pass is in `evidence-run-a/` (see §10). Per-case wall time ≤ 19 s; whole run 49.2 s of the 15-min budget; the 14-min stop never triggered.

| # | Question | Outcome | Key observations (run D) |
|---|---|---|---|
| 1 | Unobserved exit 0 / 7 | observed (+adverse note) | With no subscription at all, `list` and `snapshot` at +100 ms/+1 s/+5 s after the fixture exit-stage anchor (actual send offsets 100 / 1001 / 5003–5005 ms) all showed the PTY **present**, `lifecycle {status:"exited", exit_code:0}` / `7`, `output_head/tail 0/58` unchanged; `/proc` gone ≈9–13 ms after the exit stage. Late observer (offset 0): `attached` carried the full 58 bytes (matches oracle, pre-origin verified) and `terminal.lifecycle` already `exited`+code, but **no `exited` frame and no EOF arrived on that socket** within 2.5 s + 1.5 s. Exit information therefore appears only via list/snapshot/attach metadata, not as an event, for an already-exited PTY (window-limited). |
| 2 | Observer/controller/concurrent | observed + **adverse** | Controller `c2-ctl1` attach: role controller gen 1; each subscriber received `controller_changed` events (attachment id + generation). A second `role:controller` attach with `takeover:false` was **closed by the daemon with EOF and no response frame** (no error JSON). Takeover (`ctl3`) → gen 2 broadcast to all; `control` op by an *observer* attachment → `ok`, gen 3 broadcast (the observer's `attached.role` stays `observer` but it became controller). All four attached subscribers got identical bytes (25/25 vs oracle), all got `exited{exit_code:0, final_offset:34}` then EOF. After exit: `list` retained `exited`/0, head/tail 0/34; a fresh observer replay matched and again got no `exited` frame. |
| 3 | Explicit identity A1/A2 (groupA) + B1 (groupB) | observed | 12 frames/replays bound by instance/PTY/group/socket: 0 violations; no sub saw another PTY's marker; A2 stayed at its start gate (witness: A1/B1 started) with output offset unchanged while A2's controller arbitration changed (`controller_changed(takeover, gen 2)`); A1 and B1 exited independently (`exited` 46) while A2 remained `running`; A2 then completed. |
| 4 | Foreground child exit 7, outer shell alive | observed | `foreground_process` = `node` while the child ran, `foreground_process_changed` events `node`→`bash`. Child exit code 7 independently confirmed (fixture ack + file). **Native never surfaced the 7**: lifecycle stayed `running`, no `exited` frame, fg `bash`, shell `/proc` alive over an 8 × 125 ms window (stimulus witness: `OUTER-ALIVE` bytes observed natively + ack). Only after the separate outer gate did native report `exited{0}` (final_offset 60), shell `/proc` gone. Bytes matched oracle. |
| 5 | Replay/truncation sweep | observed; **sweep stopped at first truncation; 16 MiB not-reached** | See §8. head 0 at 64 KiB/256 KiB/1 MiB; at 4 MiB head=2097161. 16777216 and the >8 MiB frame-limit condition were **not reached** (rule: stop on first truncation); capacity beyond the examined sizes is unknown. |
| 6 | Loss/reconnect before exit | observed | Measured subscriber closed only (owner + witness stayed open); mid released after witness+running; reconnect at saved cursor 18 → `attached req18/avail18/end25 truncated:false replay 7 B`, role observer, **gen 0**; M1∪M2 coverage over [9,34): 0 holes, 0 overlaps, bytes match; both got `exited{0,34}` then EOF. |
| 7 | Loss/reconnect after exit | observed | Exit independently confirmed (ack + `/proc` + `list` exited 7 + witness `exited`). Reconnect at saved cursor 25 → replay 9 B (the post-cursor bytes, matches oracle), `terminal.lifecycle exited/7`, 0 holes/overlaps joined. **No `exited` frame and no EOF** on the reconnect socket (finite window 3 s + 2 s). Post-exit recovery is claimed only because exit was confirmed. |
| 8 | Explicit removal (`terminate`) of running fixture | observed | Response `ok` in ~11–13 ms; fixture received **SIGHUP** (fixture-side log) and `/proc` gone ≈12–13 ms after the response; fixture never reached its exit stage. Subscribers got **EOF and no `exited` frame**; `list` no longer contains the PTY; `snapshot` → `error: "terminal <id> not found"`; a new attach → **EOF without a response frame**. Distinct from spontaneous completion. |
| 9 | Owner handoff | **adverse** (prescribed order) / observed (variant) | `prepare_handoff` on old owner → ticket, ~120 s TTL. **Claim with the ticket while the old owner was still open was refused: `error "daemon already has a live owner"`** (old owner stayed open; same instance verified by registration + `ping`). *Variant B (not the prescribed order):* closed the old owner, then claimed with the same unspent ticket → `owned`; instance unchanged (pong matches, token unchanged); daemon, fixture and both pre-existing streams stayed up (no EOF/close), mid delivered to old streams and to a new subscriber at the saved cursor; all exited `{0,34}`, bytes matched. Dedicated daemon (`d9`). Socket ownership only; not Core process replacement. |
| 10 | Daemon replacement | observed + adverse | `shutdown` → `ok`; daemon pid gone (proc + exit code 0) in ~27 ms; old socket `ENOENT`; **fixture also died (SIGHUP)**; old stream got EOF, **no `exited` frame**. Fresh daemon: new `instance_id`, pid, token, socket. Old PTY id absent from the new list; **attach with old id + old cursor → EOF without response**. Fresh fixture completed fully (all 40 post-origin bytes match, `exited{0, final_offset 54}`). New daemon used a *new* runtime dir (same-dir restart over a stale `service.json` not exercised). |
| 11 | Explicit detach / repeated detach | observed | Detach = local socket destroy (`closed_local`), repeated detach no-op/no throw. Independent witness saw mid (28 ≥ 28). 0 callbacks on the detached socket in a 1 s window — *not* taken as proof of disposal; daemon-side disposal is evidenced separately: the **witness observer received `controller_changed(witness, gen 2)`** (controller departure promoted it). Re-attach with the same attachment id accepted (observer, gen 2). Exit then observed on witness/re-attached. |
| 12 | Owner close with subscribers STILL ACTIVE | observed, **adverse** | Dedicated daemon `d3` + fixture; two subscribers (controller + observer) attached, pumping, start observed (both), none previously detached/lost/removed/handed-off. Closing **only the owner socket**: both subscriber sockets got **EOF ≈8 ms later, no `exited` frame**; the **daemon exited (code 0) ≈13 ms after owner close**; the fixture PTY child was killed (**SIGHUP**); `service.json` removed; `ping` → `ENOENT`. Later gated observations not reached: the mid gate was released but the fixture never acked (dead); the exit gate was deliberately **not released** (ordering prerequisite unmet), recorded as not-reached. Dead producer was not recreated. `detach` happened only afterward (checker: 0 violations). Contrast: in case 9, closing the old owner *after* `prepare_handoff` did **not** kill the daemon. |
| 13 | *(supplementary, not requested)* External SIGKILL of an identified owned fixture | observed | `exited{exit_code: 1}` in both `list` and the `exited` frame. **No native `null` exit_code was observed in any case**; the nullable branch is unexercised. `1` is reported exactly as received and is not interpreted. |

## 8. Retention bounds (case 5, finite)

Held-live fixture, 64-byte records (`R<10-digit seq>|<51 hex>\n`), 256 KiB emission chunks (65536-byte first step), cumulative payload sizes; origin 9.

| payload | native head/tail | attach@0 | attach@captured | attach@head | attach@tail | live (tail sub from prior step) |
|---|---|---|---|---|---|---|
| 65536 | 0 / 65545 | avail 0, replay 65545, trunc false | req 9, replay 65536 | = @0 | replay 0 | – |
| 262144 | 0 / 262153 | replay 262153, false | req 65545, 196608 | = @0 | 0 | 17 frames, bytes ok, 0 holes/overlaps |
| 1048576 | 0 / 1048585 | replay 1048585, false | req 262153, 786432 | = @0 | 0 | 68 frames, ok |
| 4194304 | **2097161 / 4194313** | req 0 → **avail 2097161, truncated true**, replay 2097152 | req 1048585 → avail 2097161, truncated true | req 2097161, truncated false, replay 2097152 | 0 | 275 frames, 3145728 B ok |

- At the one truncating sample, `tail − head = 2097152` (2 MiB exactly) and truncated replays equal `end − available_offset` bytes that match the oracle. The head moved somewhere between 1 MiB and 4 MiB cumulative; the exact threshold and whether it is a ring/step is **unknown**. 16 MiB and the 8 MiB frame-limit path are **not-reached**; this is a finite measurement and says nothing about indefinite retention, other chunking, or other builds.
- Live frames averaged ≈11 KiB (frame counts vary by a few between runs; content never did).
- After exit, retention was observed only for finite windows: case 1 `list`/`snapshot`/replay still present at +5 s; case 2/7 present until `terminate`. Longer retention is unknown.

## 9. Exit vs EOF vs removal vs failure vs child exit (all separate facts)

- **Genuine PTY-process exit**: fixture exit-stage ack + `/proc` gone, native `lifecycle exited{exit_code}`, and (to *attached* streams) an `exited{exit_code, final_offset}` frame followed by EOF. Late/reconnecting observers of an already-exited PTY get lifecycle in `attached.terminal` but **no** `exited` frame/EOF in the observed windows (cases 1, 2, 7).
- **EOF alone is not exit**: EOF with no `exited` frame occurred on `terminate` (case 8), `shutdown` (case 10), owner close (case 12) and failed attach (cases 2, 8, 10).
- **Removal** (`terminate`) → response `ok`, SIGHUP to the child, record disappears; never reported as completion.
- **Child exit ≠ shell exit**: child's 7 never appeared natively (case 4).
- **exit_code**: raw `0`, `7`, `0`, and `1` (SIGKILL) observed as numbers; no `null` ever; no zero was substituted by the instrument (checked).
- Controller/foreground/`controller_changed` events are recorded as their own facts, never inferred from output.

## 10. Reproducibility, preliminary runs and deviations (read this)

- Official-form runs of the whole matrix: run A (12:30Z, earlier cleanup stage; kept as `evidence-run-a/`, its `cleanup.json` omitted: defective), run B (12:32Z, discarded: only `run.json` differed), run C (12:34Z, discarded: only a trace-field naming bug), **run D (12:37Z–12:38Z, the committed `evidence/`)**.
  Run D vs run A (`evidence/repeatability.json`): 121 of 134 derived facts identical; the 13 that differ are timings, random PTY ids, live-frame counts, a `/proc` zombie-vs-gone transient, the remaining handoff-ticket TTL (ms), and the A-run trace naming bug for case 12 sub EOF timestamps. No outcome class changed. One matrix pass each ⇒ n=2 per claim; no statistical claim.
- `evidence-run-a/run.json` had one field (host env-var **names**, no values) removed before commit; documented in `evidence-run-a/README.md`; its manifest hash is for the edited file.
- Development before the official runs: one smoke test of launch/create/list/shutdown plus five partial dev runs (cases subsets) against the same native binary; fixes made from them: gate-waiting on failed attaches, bash oracle length counting, held-live case-5 cleanup, case-9 daemon isolation + variant B, case-12 exit gating, case-13 addition. Dev outputs are not in the evidence.
- **Deviation from the prescribed handoff order** (case 9): claim-before-close was refused natively; variant B is clearly labelled and is not the prescribed experiment.
- **Isolation deviations:** some write-capable commands (python/sed edits, `mv`/`rm`/`mkdir`, offline `node` analysis) ran outside the scratch wrapper, writing only workspace files. **One accidental 4.7 KB hash-list file was written to host `/tmp/manifest.tmp` by my own command and was removed immediately** (no secrets). The cloud tool harness's own files in host `/tmp` are outside my control. All native binaries, daemons, fixtures, downloads and caches ran only inside the wrapper.
- Fixture handlers for SIGHUP/SIGTERM/SIGINT log and re-raise the default action (observational; SIGKILL unobservable). Cases use a node fixture except case 4 (bash with `set -m`, job control confirmed by `$-` = `hmB`).
- Brief interpretation notes: "payload sizes" in case 5 are cumulative totals on one held-live PTY; case 6/7/11 reconnect "same attachment id" where stated; case 3 arbitration change = `takeover:true` attach plus a `control` op.

## 11. Not exercised / unknown / missing prerequisites

Not exercised: `write`, `input`, `resize`, `read_rows` ops; `title_changed` (never observed); payloads/frames ≥ 16 MiB and the 8 MiB frame-limit response; same-runtime-dir daemon restart; ticket expiry/reuse/replay semantics; ownerless daemon behavior; retention beyond seconds; other platforms (musl, arm64, macOS); the unmodified Core client. Unknown: why owner close kills the daemon in case 12 but not after `prepare_handoff` (observed contrast only, 2 runs); why a late observer gets no `exited` frame; exact retention threshold. No missing external prerequisite blocked any case.

## 12. Cleanup and secret-redaction audit

Cleanup (`evidence/cleanup.json`, 0.87 s): gates released; owned non-owner sockets closed; each remaining daemon identity re-verified by `ping` (instance/pid) → only identified owned PTYs listed for removal → explicit `shutdown`; then owner sockets closed; all 4 daemons (pids/start-times recorded) and 17 fixtures **gone**, **no escalation** (no SIGTERM/SIGKILL needed), no leftovers; never killed by name. Fixture signal receipts: cases 5, 8, 10, 12 received SIGHUP. (Run A's cleanup closed owner sockets first, so daemons self-exited — itself consistent with case 12 — and its leftover scan false-positived on the tool shell's command text; fixed in the final scripts.)
Redaction: native tokens/tickets registered and scrubbed from all memory representations before any write; `service.json`, envelopes, env dumps (names or values), caches are **not** committed; `evidence/redaction-audit.json`: 4 daemon tokens checked, 0 matches, no token/GitHub/AWS/bearer patterns in 19 evidence files. The `ticket` appears only as `<redacted len=32 sha256_8=…>`.

## 13. Files

`probe/` (8 scripts), `analysis/extract.mjs`, `evidence/` (run D, 21 files, ~450 KiB, well under the 128/64 MiB caps), `evidence-run-a/`, `MANIFEST.sha256` (all file hashes, sha256).
Script hashes: `cases.mjs 8ed40937…`, `compare.mjs f0a5cb92…`, `controls.mjs fe4424cf…`, `fixture-shell.sh 2edadad0…`, `fixture.mjs 5255618d…`, `harness.mjs 9a9d8e63…`, `lib.mjs 113000f4…`, `run.mjs 5ec57a8d…`, `analysis/extract.mjs f1a84f2e…` (full values in `MANIFEST.sha256`).
Re-run (from a worktree with the extracted package): `scratch-run.sh node probe/run.mjs` with `EVIDENCE_DIR=<dir> NATIVE_PKG_DIR=<dir containing native/package/bin/opencode-pty>`; `scratch-run.sh` is the 10-line private-/tmp wrapper described in §4.

**No production delivery, no merge, no Core/plugin/notification proof. Nothing is to be merged from this branch.**
