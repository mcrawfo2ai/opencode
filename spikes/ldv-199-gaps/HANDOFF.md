# LDV-199 gaps: bounded cloud-native evidence-gap follow-up (A, B, C, D)

**Disposable spike. Measurements and throwaway scripts only.** Not a plan, not production code, no capability PASS, no review
approval, no Core/plugin/notification proof, no native-null result. Nothing here is mergeable; no PR was created.
Native owner close is **not** Core disposal. Direct native-wire characterization only.

## 1. Provenance

| Item | Value |
|---|---|
| fork | https://github.com/mcrawfo2ai/opencode (owner `mcrawfo2ai`; push target verified not `internetisalie`) |
| branch | `spike/ldv-199-gaps`, created **from the source pin** (not from the earlier spike tip) |
| source pin / base | `591c6999ebceb86f1b4869685d87bc2e10d9a333` (parent of the head commit) |
| head | tip of the branch as pushed; reported out-of-band (a file cannot contain its own commit hash) |
| earlier evidence consulted, not rerun | `spike/ldv-199-native-daemon` @ `5da4c1d25f8d192addb9662279cd8b556ff7435a` (first parent = the pin). Its files were **not re-read** in this task; the known finite observations in the brief were taken as stated. |
| Claude identity | session https://claude.ai/code/session_015Fcbv7BKM5xqYWTyJR8SKx. The serving model identifier is not written into repository artifacts (environment rule); it is reported in the chat report only. |
| official run | 2026-10-02T16:31:20.819Z – 16:31:54.181Z; first daemon launch → end of cleanup **32.95 s** of the 15-minute budget (14-min stop never reached) |

## 2. Read, input and baseline ledgers

- **This task's reads:** the brief `61bb9528-ldv-199-cloud-gap-brief.md` = **16989 bytes** (premeasured with `wc -c`).
- **Source files (complete, at the pin):** `daemon.ts` 22587, `index.ts` 15007, `pty-binding.ts` 282, `binary.bun.ts` 3159,
  `persistent-pty-daemon.test.ts` 10133 = **51168 bytes**. They were read in full earlier in this same session; they were not
  re-read. Snapshots were taken with `git show <pin>:<path>` into `source-snapshots/` and byte sizes confirmed equal; hashes in
  `source-snapshots.sha256`: `daemon.ts 01e3d99d…6129`, `index.ts 8b343fd3…6f9e`, `pty-binding.ts c4c835dd…c876`,
  `binary.bun.ts 5cb653dd…3e67`, `persistent-pty-daemon.test.ts 27862198…7bad`.
- **Counted task reads: 16989 + 51168 = 68157 bytes** (< 100000 target, < 128000 hard stop). No other repo files or previous evidence were loaded.
- **Baseline, counted separately:** repository `AGENTS.md` 15361 bytes (auto-loaded). No skills, cards or contracts were loaded. No subagents/reviewers/model calls were used.
- Imported dependency types (`effect`, `@opencode/schema/*`, `@opencode/util/*`, `../shell/select`) remain **unresolved by design**; wire declarations in `scripts/wire.mjs` are local transcriptions of the pinned `daemon.ts` (protocol 7).
  The fake-daemon test file was framing/owned-fixture prior art only; no fake outcome is used.

## 3. Native artifact and platform (blocked-check passed)

Acquired with `npm pack --ignore-scripts` (no install hooks, no tree install) by `scripts/acquire.mjs` → `evidence/acquire.json` (tarball sha1/sha256/sha512-integrity, `tar -tvzf` listing, per-file inventory with bytes/mode/sha256 for both packages, binding resolution note):

- `@opencode-ai/pty-linux-x64-gnu@0.1.13` tarball 1278488 B, integrity `sha512-jliNgsevGuxf…pzjhg==`; `@opencode-ai/pty@0.1.13` (binding package) tarball 1699 B.
- Executable `bin/opencode-pty`: **3138672 bytes, sha256 `b8caf78cbed9610aa5b744264aade552ed57cac70b2ebc27a788a0b1d2e02caa`**, mode 755, regular file (no symlink), path `/home/user/opencode/.spike-scratch/gaps-dl/native/package/bin/opencode-pty` (workspace scratch). It was **rehashed immediately before each of the four launches** (`exe-rehash` trace events, all `matches_pin: true`) and launched directly (no PATH lookup, no rebuild, not modified).
- Platform: Linux 6.18.44-fc-v51 x86_64, glibc 2.39 (gnu), Node v22.22.0, Python 3.11.15. Package metadata `os=linux cpu=x64 libc=glibc` compatible. Boot id `df2c3c4a-461f-4aa8-a858-2f50d8db0515`, CLK_TCK 100.
- Fixture tools (preflight, path + version + sha256 in `evidence/preflight.json`): bash 5.2.21, GNU coreutils 9.4 (`tee`, `stty`, `stat`, `sort`, `mkfifo`, `sha256sum`), grep 3.11.

## 4. Isolation and environment

- Wrapper `scripts/scratch-run.sh` (sha256 `54df417f…6b73`, the same bytes used for the run): new mount namespace (`unshare -m --propagation private`) with the workspace scratch directory bind-mounted over `/tmp`; `/proc/self/mountinfo` line recorded in `evidence/run.json` (`/home/user/opencode/.spike-scratch/tmp /tmp rw ext4 /dev/vda`), and a probe file written to `/tmp` was confirmed to land in workspace scratch. Disk-backed, not tmpfs. No host mounts/permissions changed.
- Daemon env allowlist (exactly the brief's nine names, values nonsecret, recorded in `trace.jsonl` `daemon-launched`): `HOME LANG PATH TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR OPENCODE_PTY_RUNTIME_DIR`. Child HOME/XDG/cwd are private owned paths under `/tmp/g/`. The session HOME was never changed; no credential/service variable was passed.
- Fixture env supplied in the `create` request: `PATH HOME LANG TMPDIR TERM COLORTERM SHELL`. **Names observed in the child** (`compgen -e`, names only, no values dumped): those plus `OPENCODE_PTY_RUNTIME_DIR XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR` (daemon env merged into the child by native) and `PWD SHLVL` (set by bash). See `cases/*/case.json` → `fixtures[].child_env_names`.
- The orchestrating Node process itself ran with the cloud agent's environment (161 variables; count only, names/values not recorded); it spawned daemon and fixtures only with the allowlists above.
- Native launch contract observed: `service.json` {instance_id, pid, protocol, socket, token} + `service.lock` in the runtime dir; the Unix socket is `/tmp/opencode-pty-0/<hash>.sock` (not inside the runtime dir). For every one of the four daemon launches: `registration.pid == spawned pid`, `protocol == 7`, `ping` returned a matching `pong`; ready in 55–62 ms. No TCP host/port.

## 5. What was run (serialized, one experiment)

Order: **dB** (shared daemon): B1 → B2 → B3 → D2 → D3; then **C** (dedicated daemon + same-dir relaunch); then **A** (dedicated daemon). Fixed bounds: request/readiness/gate-ack 5 s; expected-event and witnessed windows 10 s; 80×24; chunks ≤ 262144 B; frame cap 8388608; evidence caps 128 MiB total / 64 MiB per case with 4 MiB reserved (actual **30.19 MB**, per-case max D3 29.57 MB; **no limit hit**).
Roles: **M** = measured subscriber; **W** = witness observer (an observer that **may perturb the producer**; its bytes confirm delivery but are not the oracle). A used M=controller, W=observer; B/C/D used observer/observer.

Fixture design (`scripts/fixture.sh`): non-interactive bash; control plane is filesystem gates/acks only (**no PTY input**); raw mode set and verified (`stty -echo -opost`, `stty size` = `24 80`; `mode.saved/before/after/size` saved to files, never to PTY stdout); every PTY byte is emitted by `tee -a ORACLE < immutable-payload-file` with its status checked directly (no pipeline, no prompts); a stage ack (`oracle_len`, `payload_len`, fixture wall µs) is written only after the tee succeeded. Nothing is emitted before the start gate, so origin **O** (native `head == tail`, read from a raw native `list` payload while start was held) is **0** in every fixture (no native pre-origin bytes; `pre_origin_bytes` = 0 in all comparisons). The oracle is frozen (immutable copy, length + sha256) at each boundary; boundary prefix hashes are in `oracle.boundaries.json` and the final frozen oracle is stored once as `oracle.frozen.bin`. An exit gate is released only after: intermediate ack **and** W/M delivered bytes **and** a native `list` showing `running` while exit is held (checked online and re-checked offline).

## 6. Evidence layout and trust map

```
evidence/trace.jsonl            ordered monotonic action trace (seq, t_ms monotonic, wall_ms, case, kind, ...)
evidence/results.json           client-derived results per case          evidence/qualification.json  rule-derived claim qualification
evidence/run.json cleanup.json preflight.json acquire.json
evidence/cases/<case>/case.json fixtures[] (pty id/group/instance, origin sample, create_rx, oracle, boundaries), daemons[], sockets[]
  captures/<sock>.rx.bin        LOSSLESS raw bytes received on that socket (uint32BE length + payload frames), written before parsing
  captures/<sock>.index.jsonl   client-derived frame index (hdr offsets, kinds, conn events)   <sock>.meta.json  client-derived metadata
  captures/<sock>.replay.bin    decoded attached-replay bytes (cross-checked against the base64 inside rx.bin)
  requests/NNNN-*.rx.bin        raw native responses for request sockets (create, snapshot, ping, shutdown, own, ...)
  samples/*.jsonl               raw native `list` payloads (lossless payload text) used for origin/running/watch/retention samples
  fx-<name>/                    plan.txt stage.log gate-log.json acks/*.json mode.*.txt env-names.txt payload-index.json oracle.frozen.bin oracle.boundaries.json
evidence/offline/verify-report.json selfcheck-report.json
```
**Captured native facts:** `*.rx.bin`, `requests/*.rx.bin`, `samples/*.jsonl` raw payloads, `replay.bin` (decoded from native). **Fixture-side facts:** oracle, acks, stage.log, mode files, payload hashes. **Client-derived claims (not native facts):** `results.json`, `*.meta.json`, `*.index.jsonl`, trace event times, EOF/close events (a socket EOF is not bytes, so it exists only as a client observation), `/proc` identity/state witnesses, and all online `max_end`/delivery decisions. The offline verifier re-derives frames, bytes, identity and ordering from the raw files and cross-checks the client index; it trusts `trace.jsonl` only for event order (cross-checked with fixture-side ack wall clocks) and `case.json` only for file locations.

**Redaction/sanitization (before any write):** daemon tokens (and tickets, none were issued) are registered in memory the moment `service.json` is parsed; every structured write goes through a scrubber that replaces any `token`/`ticket`/`sealed`/`password` field with `<redacted len=… sha256_8=…>` and any registered secret substring with `<redacted-secret>`; every raw byte chunk is checked for registered secrets before it is appended to an `rx.bin` (a hit would stop that capture and make the claim unknown; there were **0** hits). Transmit frames (credential-bearing) are **never stored**; `service.json` contents are never stored (only presence/size/mode/mtime inventory); no environment dump (names or values) of the agent is stored; child env is names-only. Registration appears only as `{instance_id, pid, protocol, socket, keys, token:"<memory-only>"}`. Audit (`run.json` → `redaction_audit`): 333 files / 29,924,448 bytes scanned, 0 secret matches, 0 token/GitHub/AWS/bearer pattern matches. Native binary output frames are preserved byte-for-byte; no output byte was edited.

## 7. Results and qualification

Qualification vocabulary: **valid** (observed, prerequisites met, offline checks green), **adverse**, **timed-out** (expected event absent at deadline), **unknown / not-reached**. Machine-derived list: `evidence/qualification.json` (rules in `analysis/qualify.mjs`). Offline verification of all cases: **173 checks, 0 red** (`evidence/offline/verify-report.json`).

### A — pre-close MID variant (dedicated daemon `dA`, fixture A; **not** the original N15 owner-before-MID order; case 12 is not changed)

| Step | Result | Qualification |
|---|---|---|
| M (controller) + W (observer) attached/pumping; START tee'd+acked, delivered to both; MID tee'd+acked (`oracle_len` 14), delivered to both (M and W bytes to offset 14), native `running` while exit held; M/W/owner open | all established (trace seq ≤ 355; ack files before owner close) | valid |
| `owner-close-action` logged **seq 356** (t = 16901.56 ms), then only the owner socket destroyed | EOF/daemon death sequenced after it (offline check green) | valid |
| first 10 s window (20 samples, 500 ms) | owner connection closed +0.2 ms; **M and W EOF at +10.0/+10.1 ms; daemon exit event (code 0, no signal) +10.2 ms; M/W close +10.3 ms**; no `exited` frame on either (their rx.bin end cleanly after the MID frames; no incomplete tail). First sample (+10 ms): daemon `zombie`, fixture `gone`, `service.json` still present but `ping` failed, `list` ECONNREFUSED; by the last sample (+9.5 s): daemon `gone`, registration missing (ENOENT), ping/list ENOENT | **adverse** |
| post-close emission stimulus: `post` gate released at +10 042 ms | `post-emitted` ack **absent at its 5 s deadline** (+15 050 ms); fixture and daemon already gone; not recreated | **timed-out** (adverse) |
| native running re-check / exit release / second 10 s window | native running **unverifiable** (daemon not alive) so the exit gate was **not released** | **not-reached** (prerequisite) |
| property observation finished before any cleanup detach | `property-observation-end` logged; M/W sockets had already been closed by the daemon, recorded as `sub-detach-skipped`; no detach-first cleanup | valid |

### B — nullable exit code, three bounded attempts (shared daemon `dB`)

| Attempt | Path | Native lifecycle (raw) | `exited` frame on M and W (raw payload text) | Windows |
|---|---|---|---|---|
| B1 | gated normal exit, code 7 (also D1 live-exit capture) | `{"status":"exited","exit_code":7}` (list/snapshot) | `{"type":"exited","exit_code":7,"final_offset":25}` then EOF on both | fixture exit-stage ack, `/proc` gone +30 ms after release, native list exited 20 ms after the fixture exit-stage ack |
| B2 | identity-rechecked `SIGTERM` (pid/start/boot re-verified, cmdline contains fixture dir) | `{"status":"exited","exit_code":1}` at +8 ms | `{"type":"exited","exit_code":1,"final_offset":16}` then EOF | no fixture exit-stage ack (not a gated exit); `/proc` gone +11 ms; 10 s deadline not hit |
| B3 | identity-rechecked `SIGKILL` | `{"status":"exited","exit_code":1}` at +8 ms | `{"type":"exited","exit_code":1,"final_offset":16}` then EOF | same |

**Native-null branch: NOT OBSERVED / UNKNOWN.** No raw `exit_code: null` appeared in any list/snapshot lifecycle or `exited` frame across the three attempts (7, 1, 1). The old supplementary SIGKILL result (1) is consistent and was not reinterpreted. Nothing was rewritten to null, no missing value was mapped to zero, and EOF/failure were never labelled exited. The offline null-to-zero check was exercised only on a **synthetic** stream (§8).

### C — same exact runtime-directory restart (dedicated daemon `C1` → `C2`)

- Exact runtime dir: **`/tmp/g/rt-C`** (inside the private bind; backing path `/home/user/opencode/.spike-scratch/tmp/g/rt-C`). Nonsecret inventory, **before shutdown:** `service.json` file 207 B mode 600, `service.lock` file 0 B mode 644; socket dir `/tmp/opencode-pty-0/` held 2 sockets. **After shutdown (as found, nothing deleted by me):** `service.lock` only (the daemon removed `service.json` itself); 1 socket remained (the other daemon's). **After relaunch:** `service.json` 207 B 600 + `service.lock`; sockets back to 2.
- MID proven with exit held, old cursor 22; `shutdown` requested only after identity (pid/start/boot) + `ping` verification → `ok`; daemon gone **21 ms** later (exit event code 0), verified by recorded identity; fixture **gone**; old M/W got **EOF with no `exited` frame** (**adverse**, valid observation).
- Relaunch of the same binary in the same directory: readiness polls `missing` (+2 ms) → `ok` (+55 ms); registration pid == launched pid, protocol 7, ping matched; **no stale-registration error, no readiness timeout**. New instance_id, pid, start-time and token differ from the old daemon; the **socket path is unchanged** (same hash, same exact directory).
- On the new instance: old PTY id **absent from `list`**; `snapshot` of it → `error "terminal <id> not found"`; attach at old cursor 22 → **EOF with no response frame** (0 bytes in `old-cursor-attach.rx.bin`). Changed instance identity is **not** continuity (**adverse**).
- Fresh gated PTY on the new instance completed (START/MID/FINAL, `exited{exit_code 0, final_offset 34}`, bytes verified offline) — valid.

### D — small independent recomparison captures

- **D1** = B1 (live exit): M and W frames recompared offline to the frozen oracle (25/25 bytes each) — valid.
- **D2** (`dB`): M closed at saved cursor 9 (W + owner active); MID acked, W bytes, native `running`; M2 reconnected at cursor 9 → `attached observer gen 0, requested 9, available 9, end 16, truncated false, replay 7 B`, native `running` confirmed **before** exit release; then exit (code 0, `final_offset` 25) seen by M2 and W; holes 0, overlaps 0; all bytes equal oracle — valid.
- **D3** (`dB`, retention, held live; W attached from O): stage S1 (64 KiB baseline `base.bin`, acked): list head/tail **0/65536**; attaches at 0 / saved(0) / head(0) / tail(65536) all `truncated false`, replays 65536/65536/65536/0 bytes, equal to oracle. Stage S2 (15×262144 + 196608 B chunks = **4194304 B cumulative**, all 16 chunk acks within 5 s): list head/tail **2097152/4194304**; attach at 0 → `requested 0, available 2097152, end 4194304, truncated true`, replay 2097152 B; at saved 65536 → `available 2097152, truncated true`, 2097152 B; at head 2097152 → `truncated false`, 2097152 B; at tail → 0 B. All replay bytes equal `oracle[2097152:4194304)`. W live: 373 output frames, 4,202,699 rx bytes, covering [0, 4194313) with 0 holes/overlaps, equal to the 4194313-byte frozen oracle. After release (FINAL 9 bytes) the exit was observed (W exited frame, code 0, final_offset 4194313). **Finite post-exit samples** anchored to W's `exited`-frame receipt (client time) at actual **+100 / +1001 / +5003 ms**: list `{"status":"exited","exit_code":0}`, head/tail **2097161/4194313** each time; snapshots retained separately (`requests/*ret-snapshot-D3-*.rx.bin`, text 146208 chars, checkpoint base64 198364 chars); a later attach at head 2097161 → replay 2097152 B, `truncated false`, equal to oracle. **Observation only:** at 4 MiB cumulative the retained window was exactly 2 MiB (the head moved with the 9 added bytes). **This is not a capacity guarantee; the threshold between 64 KiB and 4 MiB, larger payloads and longer retention remain unknown** (payloads were not increased).

## 8. Independent offline verification and mutation self-check (statuses)

`offline/verify.py` is standard-library Python and imports nothing from the Node client or its comparator. Commands (run from the repo root; `scratch-run.sh` only keeps writes off host /tmp):

```
# 1. acquire (status: exit 0, executable sha256/size/platform OK)
SCRATCH=/home/user/opencode/.spike-scratch   # wrapper S= path
spikes/ldv-199-gaps/scripts/scratch-run.sh node spikes/ldv-199-gaps/scripts/acquire.mjs $SCRATCH/gaps-dl spikes/ldv-199-gaps/evidence/acquire.json
# 2. experiment (status: completed, exit 0; 32.95 s; audit ok)  -- writes into evidence/
EVIDENCE_DIR=$PWD/spikes/ldv-199-gaps/evidence NATIVE_EXE=$SCRATCH/gaps-dl/native/package/bin/opencode-pty spikes/ldv-199-gaps/scripts/scratch-run.sh node spikes/ldv-199-gaps/scripts/run.mjs
# 3. offline verify all cases (status: exit 0; 173 checks, 0 red)
python3 spikes/ldv-199-gaps/offline/verify.py all --evidence spikes/ldv-199-gaps/evidence --report spikes/ldv-199-gaps/evidence/offline/verify-report.json
# 4. offline mutation self-check (status: exit 0; ALL PASS, 8/8)
spikes/ldv-199-gaps/scripts/scratch-run.sh python3 spikes/ldv-199-gaps/offline/selfcheck.py --evidence spikes/ldv-199-gaps/evidence --work /tmp/selfcheck --report spikes/ldv-199-gaps/evidence/offline/selfcheck-report.json
# 5. reconstruct native [a,b) from frame/replay files and compare to frozen oracle [a-O,b-O)  (O<=a<=b<=O+B)
python3 spikes/ldv-199-gaps/offline/verify.py interval --evidence spikes/ldv-199-gaps/evidence --case D3 --fx D3 --socket S2-at0 --a 2097152 --b 4194304   # equal:true, 0 holes
python3 spikes/ldv-199-gaps/offline/verify.py interval --evidence spikes/ldv-199-gaps/evidence --case B1 --fx B1 --socket W --a 0 --b 25                      # equal:true
# 6. qualification table (status: exit 0)
node spikes/ldv-199-gaps/analysis/qualify.mjs spikes/ldv-199-gaps/evidence
```
Per-socket checks include: frame well-formedness (length header ≤ 8388608, tag-0 output frames ≥ 17 bytes, uint64 safe-integer offsets, end ≥ start, end−start = payload length), replay file = base64 in rx.bin, independent frame-index = client index, exact bytes vs frozen oracle (first difference, lengths, sha256s, holes/overlaps reported not concatenated), identity binding (attached terminal id/group vs the raw `created` response; instance vs raw `pong`), raw exit_code preservation (key presence and value), oracle-boundary prefix hashes, terminal mode (`-echo -opost`, `24 80`), origin `head == tail`, exit-gate ordering (trace order + fixture-side ack wall clocks) and case-A owner-close ordering. A hash match was **not** used as approval of the instrument.

**Self-check mutations (run on a working copy; `evidence/offline/selfcheck-report.json`)** — each: baseline green → mutate → red with the actual reason → restore from original bytes (sha256 identical) → green:

| Mutation | Red check and actual reason |
|---|---|
| changed observed byte (XOR 0xFF at payload byte 2 of B1/W's first output frame) | `bytes-vs-oracle:W`: first difference at native offset 2, native 190 vs oracle 65 |
| changed observed offset (start/end header +1) | `bytes-vs-oracle:W`: first difference at offset 1, native 83 vs oracle 84 |
| omitted intermediate ack (trace) | `ordering:exit-gates`: exit gate released without a prior intermediate acknowledgment |
| early exit release (native-running/release swapped) | `ordering:exit-gates`: released without a native-running observation after the intermediate ack |
| detach before owner close (A trace) | `ordering:case-A-owner-close`: sub-detach sequenced BEFORE owner-close-action |
| wrong identity (PTY id +1; instance id substituted) | `identity:M`: meta expected pty_id ≠ raw created id; expected instance ≠ raw pong instance |
| null-to-zero (**synthetic** stream; instrument rule only) | `exit-code-preservation`: recorded 0 ≠ raw wire null; wire 0 ≠ recorded null |

## 9. Cleanup, leftovers, deadlines

`evidence/cleanup.json` (1.28 s, after all observation windows ended): closed 39 owned non-owner sockets → released remaining gates → for each live daemon: identity re-verified (pid/start/boot) + `ping` (instance/pid) → removed **only recorded** PTYs (dB: 5, C2: 1; `ok`) → `shutdown` requested (`ok`) → owner sockets closed → **no escalation needed** (no signal sent); all 4 daemons and 8 fixture processes reaped/`gone`; **0 leftovers, 0 cleanup errors**. Scratch files under the private `/tmp` bind are not committed. Reserved 60 s and the 5 s graceful/5 s-per-escalation allowances were never used. No identity mismatch occurred.

## 10. Limits, deviations and things not done

- **Single trial per scenario.** Timings are client-observed (ms granularity); two-run repeatability was not re-measured here.
- **Development runs preceded the official run** (scratch only, not evidence): two B1-only runs, one full-matrix run (43 s) and a dev self-check; fixes made: record an EOF consumed during a failed attach, record skipped detaches, include daemon-launch captures in the self-check copy. The official run is the single committed experiment.
- **Isolation deviation:** some write-capable edit/analysis commands (python edits, `cp`, `mkdir`, `node` analysis) ran outside the scratch wrapper but only wrote workspace files; the native daemon, fixtures, downloads and all experiment output ran inside the wrapper. The cloud tool harness's own host-`/tmp` files are outside my control.
- A's second window / exit observation **not reached** (native running unverifiable) — by design of the brief, not a harness failure.
- W is an observer that may perturb the producer; its delivery confirmation was never used as the byte oracle.
- Replay start offset is not on the wire; the verifier derives it from lengths (`requested_offset` if length = end−requested and requested ≥ available, else `available_offset`); every replay here satisfied at least one rule (0 `unverified`; 23 byte comparisons, 0 pre-origin bytes).
- Not done (and why): no larger/longer retention (brief forbids forcing it); no full N01–N15 rerun (out of scope); no handoff/ticket test; no write/input/resize/read_rows operations; no signals other than the two permitted; no alternative programs to force null; no Core client, no multi-trial statistics. The retention threshold, longer-term retention, why owner close kills the daemon, and native null remain **unknown**.

## 11. Files

`scripts/` (acquire, lib, wire, harness, cases, run, fixture.sh, scratch-run.sh) · `offline/` (verify.py, selfcheck.py, manifest.py) · `analysis/qualify.mjs` · `source-snapshots/` + `source-snapshots.sha256` · `evidence/` · `MANIFEST.json` / `MANIFEST.sha256` (every file with length and SHA-256, generated by `offline/manifest.py`; it excludes itself) · this `HANDOFF.md` (included in the manifest).
Script sha256 (full values in the manifest): acquire.mjs `16d5896f…`, cases.mjs `acec4f86…`, harness.mjs `6fab4508…`, lib.mjs `b90bdbb6…`, run.mjs `91029f46…`, wire.mjs `d0c54b16…`, fixture.sh `035d253d…`.

**No invented artifact-store key, capability PASS, review approval, production delivery, Core/plugin/notification proof or native-null result.**
