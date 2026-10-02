# LDV-208 patch-size spike: shared turn observation in the zeroclaw gateway

Throwaway measurements, scripts and a throwaway patch. No PR, issue, comment or contact upstream; no zeroclaw fork. Single cloud seat, no sub-agents.

## Answer in one paragraph
**How big is the patch, and would upstream take it?** Items 1-3 fit in **one file** (`crates/zeroclaw-gateway/src/ws.rs`), **174 lines added / 12 removed including rustfmt expansion and a 5/4-line test edit** (about 169 / 8 outside the test), with **no new public type, no config key and no new frame type**; the wire change is additive (`session_id`, `turn_id`, `seq` on every turn frame, `replay:true` on replayed ones). It reuses two things the gateway already has: the shared bus `state.event_tx` plus its per-session filter, and the 500-frame `state.event_buffer` ring. With it, a second socket on the same session sees the whole turn live (Q1), a socket that joins or reconnects mid-turn is caught up from the ring (Q2), and `/messages` shows the user prompt at admission and each tool-call/tool-result boundary during the turn (Q3). Approvals (Q4): the request becomes visible to every attached socket for free; answering from any socket is **not** free (the pending-approval map is per connection) and was not attempted; the owner-only rule is kept explicitly. My judgement is **small and additive for Q1+Q2 (~150 lines), moderate overall because of Q3**: Q3 changes what `/messages` and `session_start.resumed/message_count` report mid-turn, flipped one existing test's assertions, and synthesizes provisional transcript rows in the prompt-guided `<tool_call>` shape. The recent merged work in this area (#10538 detach-and-continue) explicitly left "live reattach or event replay" for later, so the direction is plausible, but #9355 (merged) assumes the opposite per-pane model (one conversation per pane, separate `Agent` instances per socket), so a maintainer would want that interaction discussed first. It would plausibly be an ordinary issue + PR (not an RFC, by their own RFC rules), but not as one PR; split Q1+Q2 from Q3.

## Provenance
- Fork: https://github.com/mcrawfo2ai/opencode (push remote owner `mcrawfo2ai`; nothing pushed elsewhere; other branches untouched).
- Branch: `spike/ldv-208-zeroclaw-patch`, created from `47530d85a35afff386b9b8463192017d18c1b785` (observers spike head). Head = the commit containing this file (SHA reported in chat).
- Under test: zeroclaw `74362c2d6bfeaa81cc611e75cd07b7f3afd52d64` (v0.8.5), full clone checked out at the exact pin.
- Upstream default-branch head at start: `afc47d333c90211f92ca3eca80cd2293c72c5025` (2026-10-02 16:47Z, `fix(config): lock the loader's data dir and resume interrupted splits (#11370)`); re-fetched near the end: unchanged.
- Patch commit in the throwaway clone: `368b75adb28c4ffaae4f5f89a1f0469326eb95df` (message says throwaway; no attribution trailers, because zeroclaw's CONTRIBUTING forbids them). Artifacts: `zeroclaw-shared-turn.patch` (`git format-patch`) and `zeroclaw-shared-turn.diffstat`.
- Platform: Linux 6.18.44 x86_64, rustc/cargo 1.97.0, bun 1.3.x, node 22. Build: `cargo build --bin zeroclaw --no-default-features --features agent-runtime,gateway` (first build 5m35s; each patched rebuild 20-30 s incremental).
- Binaries (debug, ~1.2 GB, not committed): baseline sha256 `7bb6c0fc…`; measured patched `f2c5f90a…` (before rustfmt); final rustfmt'd `ee5cb375…` (smoke-tested only, see deviations).
- Isolation: unchanged from the observers spike driver: loopback only, private run dir per run, children under `env -i` with an allowlist (PATH, fixture HOME, LANG, NO_PROXY, RUST_BACKTRACE, ZEROCLAW_CONFIG_DIR/DATA_DIR), stub provider only, no cloud/GitHub/provider secrets. Ports and PID/start-ticks are in each `evidence/*/*/run-meta.json`. Every process was signalled only after its `/proc/<pid>/stat` start-ticks matched (`identity_matches_before_signal:true`) and `alive_after:false` for all (checked for all 7 evidence dirs); `pgrep` shows no leftover process. Redaction: scratch paths replaced by `<SCRATCH>`/`<REPO>`/`<TMP>`; a pattern scan for tokens/keys found nothing.
- Reused unchanged (byte-identical, `cmp` against the observers spike): `scripts/run-observers.mjs`, `harness.mjs`, `stub_provider.py`, `show.mjs`, `samples-digest.mjs`. New: `scripts/frame-seq.mjs` (per-socket frame sequences from the raw jsonl) and `scripts/msg-counts.mjs` (`/messages` snapshots).

## Read ledger
`evidence/read-ledger.tsv`: 60 rows, **114,713 bytes** (target 100 KB, hard 128 KB, so over target, under hard). Three rows are estimates (initial listings, unlogged small outputs, MCP/WebFetch results). Not counted: the brief and the injected AGENTS.md. Source reads were bounded line ranges of `ws.rs` (~1,000 lines in total), `sse.rs`, `broadcast.rs`, `session_backend.rs`, CONTRIBUTING and `rfcs.md`; build/test logs went to files and only summaries were read.

## Method
Same driver as the observers spike, run against the baseline binary and the patched binary: `ONLY=s1a_both_before,s1b_B_midturn,s1c_B_after_done,s3a_owner_drop,s3b_owner_drop_B_attached,s4_reconnect` in `main` mode, plus `approval` mode (s5, answer from A / from B), plus the `extra-main` (x2) and `extra-approval` (x1) extras. Raw frames per socket are in `evidence/<variant>/<mode>/<scenario>.<sock>.raw.jsonl`. Note on naming: the brief's "Q4" in "Q1, Q3 and Q4 from the observers spike" is taken as the observers spike's Q4 (reconnect mid-turn); brief item 4 (approvals) was measured with that spike's Q5 scenarios.

Shorthand: SS `session_start`, CH `chunk`, TC `tool_call`, TR `tool_result`, DN `done`, AR `approval_request`, ERR `error`; `#n` = new per-turn `seq`; `(r)` = replayed frame; `@ms` = driver monotonic ms.

Evidence variants: `baseline/` (pin, unpatched), `patched/` (final measured binary), `patched-final-smoke/` (rustfmt'd final binary, 3 scenarios), and three superseded patched attempts kept for honesty (`patched-attempt1-no-early-attach`, `-attempt2-stale-backlog`, `-attempt3-x2-late-done`; see "What the attempts found").

## Q1. Shared turn frames (patched; ~86 lines for the core, +~33 for queued-prompt ordering)
**Patch (excerpt, `ws.rs`):** one choke point where every turn frame is built is wrapped; the owner still writes its own frame directly, and the same frame, stamped, is also published for everyone else.
```rust
fn publish_turn_frame(state, conn_id, session_id, turn_id, seq: &mut u64, mut frame: Value) -> Value {
    *seq += 1;
    frame["session_id"] = session_id.into(); frame["turn_id"] = turn_id.into(); frame["seq"] = (*seq).into();
    state.event_buffer.push(frame.clone());                       // Q2: late-join ring
    let mut published = frame.clone(); published["origin_conn"] = conn_id.into();
    let _ = state.event_tx.send(published);                       // existing bus, filtered per session
    frame
}
```
Call sites (4): the main frame match (chunk, thinking, tool_call, tool_result, approval_request, history_trimmed, plan), the in-loop approval_request site, `aborted`, and each frame of the terminal `done` group. Receiving side: a socket subscribes to `event_tx` right after `session_start` (previously only after its first client message, which meant an attach-only socket never entered the loop), drops frames tagged with its own `origin_conn`, strips that tag, and forwards the rest through the existing `event_matches_session` filter. The tag is also needed because the owner does not read the bus during its own turn.

| scenario | before (baseline) | after (patched) |
|---|---|---|
| 1a B attached before prompt | A `SS CH TC TR CH DN`; B `SS` | A and B both `SS CH#1 TC#2 TR#3 CH#4 DN#5`, same `turn_id`, B's frames arrive within 1-2 ms of A's |
| 1b B attached mid-turn | B `SS` only | B `SS CH#1(r) TC#2 TR#3 CH#4 DN#5` (see Q2) |
| 1c B attached after `done` | B `SS` (`message_count:4`) | B `SS` only: an ended turn is not replayed |
| x2 B prompts while A's turn runs | B got its own turn only; A got only its own | A and B each see both turns, in order, each frame stamped with its own turn's id |
| 3b owner drops mid-turn, B attached | B `SS` only | B `SS CH#1 TC#2 TR#3 CH#4 DN#5` (the unattended turn is now watchable) |

Raw sequences: `evidence/baseline/main/*` vs `evidence/patched/main/*` (`bun scripts/frame-seq.mjs <dir>`).

## Q2. Late-join catch-up (patched; ~30 lines)
**Choice and why (deviation, see below):** I implemented the **bounded replay buffer** although the persisted-state alternative is smaller in code. Persisted partial state costs nothing beyond Q3, but at the "after first chunk" sample `/messages` holds only the user row (n=1; the chunk text enters the transcript only at the tool-call boundary), so a joiner could not learn what it missed in the step in flight, and there is no join point between the HTTP read and the live stream. The buffer reuses the existing `AppState.event_buffer` (the 500-frame ring behind `/api/events/history`, `EVENT_HISTORY_CAPACITY`) so there is no new storage type.
```rust
fn current_turn_frames(buffered: &[Value], session_id: &str) -> Vec<Value>  // newest turn of the session unless its last frame is done/aborted
// at attach: subscribe first, then replay with "replay": true, remember (turn_id, last_seq); the live path skips seq <= last_seq of that turn
```
| scenario | before | after |
|---|---|---|
| 1b B joins mid-turn (stub held at g2) | `SS` (`message_count:0`), nothing else | `SS CH#1(r)@8915 TC#2 TR#3 CH#4 DN#5`: the missed chunk replayed, the rest live, no duplicates |
| 4 A reconnects (A') 0.85 s after drop | A' `SS` only; the turn's output reaches nobody | A' `SS CH#1(r) TC#2 TR#3 CH#4 DN#5` |
Limits, not measured: the ring is shared with observability events and lossy (500 frames) so a long or token-heavy turn can evict early frames (a `seq` gap is detectable by the client, there is no signal from the gateway); bus receivers use `if let Ok(..)` so a lagged receiver silently skips frames.

## Q3. Incremental persistence (patched; ~20 lines)
**Patch:** `append_provisional(state, session_key, msg)` calls `backend.append`: the user prompt at turn admission (after the history refresh, under the session permit), an assistant row (step text + `<tool_call>` JSON) at each `ToolCall`, a user `[Tool results]` row at each `ToolResult`. All turn-end paths already replace the whole transcript with the agent's authoritative history (`replace_conversation_state…`), so the provisional rows are overwritten, never duplicated (final counts below are 4, as before).

`/api/sessions/S/messages` message count (final patched evidence vs baseline; the driver samples at fixed points):
| scenario / point | baseline | patched |
|---|---|---|
| 1a after first chunk | 0 | 1 (user) |
| 1a before final chunk | 0 | 3 (user, assistant+tool call, tool results) |
| 1a after done | 4 | 4 |
| 3a owner dropped, +1 s / +2 s / before final | 0 / 0 / 0 | 1 / 1 / 3 |
| 3a final; 3b final; 4 final | 4; 4; 4 | 4; 4; 4 |
Evidence: `bun scripts/msg-counts.mjs evidence/{baseline,patched}/main`.
Risks I did not test: provisional rows use the prompt-guided tool format and will not match a natively tool-calling provider's real shape until turn end (a socket connecting mid-turn seeds its history from them; the existing generation/watermark check rebuilds on its next turn, which the existing test below still passes); a gateway crash mid-turn leaves an orphan user row; non-sqlite `SessionBackend`s; session deleted mid-turn.

## Q4. Approvals (stretch)
**Which the code makes easier: visible to all, owner-only kept explicit.** Visible-to-all needs no extra code: `approval_request` goes through the same publish path as Q1 (the in-loop site is stamped and published). Answering from any socket is not cheap: `PendingApprovals` (the request-id to oneshot map) is created per connection (`new_pending_approvals()` at `ws.rs` L674 at the pin) and `approval_response` is parsed in two socket-local places (idle loop L841, in-turn loop L1893); a shared answer path means a per-session registry in `AppState` plus a decision on who may answer. Not attempted.
| | baseline | patched |
|---|---|---|
| request, B attached | A `SS CH AR TC TR CH DN`; B `SS` | A as before (stamped); B `SS CH#1 AR#2 TC#3 TR#4 CH#5 DN#6` |
| answered from A | honoured (TC 3 ms later) | honoured, B sees the rest of the turn |
| answered from B | B gets `ERR` ("Unsupported message type"), turn stalled until A answers | the same: B gets `AR#2` then `ERR`, turn stalled until A answers, then completes |
| x1 owner closes with a request pending | B `SS` only | B `SS CH#1 AR#2 TC#3 TR#4 CH#5 DN#6`: B sees a request nobody can answer, then TC/TR and the final text (consistent with the observers spike's x1 finding that the runtime denies at once; I did not re-read the denial text) |

## Tests (`cargo test -p zeroclaw-gateway --lib`, log to file, summary only; `evidence/tests/`)
| run | passed | failed | failing names |
|---|---|---|---|
| baseline at the pin | 637 | 1 | `api_config::tests::unreadable_existing_config_survives_failed_save_rollback` (also fails on the pin; cause not investigated, plausibly because the container runs as root) |
| patched, code only | 636 | 2 | the same, plus `ws::tests::reconnect_during_detached_turn_refreshes_history_before_the_follow_up` |
| patched + 2-assertion test edit (in the patch) | 637 | 1 | only the pre-existing one |
The second failure is the intended contract change of Q3: that test asserts a mid-turn reconnect sees `resumed:false, message_count:0` ("nothing is persisted yet"); with admission-time persistence it is `true`/`1`. The rest of that test (the follow-up runs on the transcript the detached turn persisted) passes unchanged. I added **no new tests** for the new functions; upstream would require them. Deviations on test scope are listed below.

## Size
| | files | added / removed (rustfmt'd, hand-attributed from the `-U0` hunks, approximate) | new pub types | new config keys | wire |
|---|---|---|---|---|---|
| Q1 core | `ws.rs` | ~86 / ~8 | 0 | 0 | additive: optional `session_id`, `turn_id`, `seq` on turn frames |
| Q1b queued-prompt ordering (macro `forward_while_waiting!`) | `ws.rs` | ~33 / 2 | 0 | 0 | none |
| Q2 | `ws.rs` | ~30 / 0 | 0 | 0 | additive: `replay:true` |
| Q3 | `ws.rs` | ~20 / 0 | 0 | 0 | none on the wire; `session_start.resumed/message_count` and `/messages` values change mid-turn |
| Q4 | none | 0 | 0 | 0 | none (visible-to-all falls out of Q1) |
| existing test edit | `ws.rs` tests | 5 / 4 | | | |
| **total** | **1** | **174 / 12** (`git diff --stat`) | **0** (private fns and one macro) | **0** | **additive**, no new frame types, none breaking for JSON consumers that ignore unknown keys |
Behavior not on the wire: turn frames now ride the existing shared bus (`event_tx`) tagged with a `session_id`; `is_public_event`/SSE already excludes session-scoped events per its own unit test, but I did not measure `/api/events` or `/api/events/history` for leakage. Frames not covered: the terminal `error` frame (`send_ws_turn_failure`) and the pre-turn `history_trimmed` frame, so an observer gets no terminator when a turn fails.

## What the attempts found (all superseded, evidence kept)
1. **attempt1 (no early attach):** Q1 had no effect on the unchanged driver: `evidence/patched-attempt1-no-early-attach`. Cause: a socket only subscribes to the bus and enters its main loop after its first client message (the connect/prompt wait at `ws.rs` ~L487), so an attach-only observer never received anything. Fixed by subscribing and replaying right after `session_start`, with a bus arm in that early wait loop.
2. **attempt2 (stale backlog):** in x2, B's prompt queued on the session permit and then received A's turn frames only after its own turn, late and out of order (`evidence/patched-attempt2-stale-backlog/extra-main`). Fixed by forwarding bus frames while waiting for the permit (`forward_while_waiting!`, both permit sites).
3. **attempt3 (late done):** a random `select!` branch sometimes let the permit win over A's already-published `done`, so it still arrived late (`evidence/patched-attempt3-x2-late-done/extra-main`). Fixed with `biased;` (bus first). Final x2 evidence is clean.
4. Test regression found by running the crate's tests (see Tests).

## Upstreamability (read only; nobody contacted)
**CONTRIBUTING / RFC rules (read in the clone):** one concern per PR; prefer XS/S/M; PR template mandatory; validation evidence required; squash-merge with conventional commits; no bot/AI attribution trailers. An RFC is for a security-model change, governance, a cross-cutting refactor that changes ownership or contracts across established boundaries, or a new subsystem; an "ordinary feature addition", a schema change or a bounded refactor goes through an issue and a PR. This is an ordinary gateway feature, with the caveat that "who owns a session" semantics could be argued as crossing a boundary.

**Related issues/PRs on zeroclaw-labs/zeroclaw** (found with 7 keyword searches and `git log --grep` on the clone; the GitHub MCP could search but `pull_request_read` was refused for this repo, I did not attach it with push credentials, and four PR/issue pages were summarized by a small model via WebFetch, so treat those descriptions as unverified):
- #10538 merged (2026-09-24, in the pin): keep the agent turn running when the chat WebSocket disconnects (`detach_mid_turn`, sockets are "viewers" not owners). Summary says it defers "live mid-stream reattach or event replay" to #9002.
- #9002 open: "keep agent turns alive after viewer disconnect"; summary says blocking review findings about reconnect state; no fan-out of frames to several viewers.
- #9355 merged (2026-09-03, in the pin): open the same agent in several chat tabs; each pane owns its conversation; two sockets on one gateway session get separate `Agent` instances seeded from different snapshots. This is the design assumption my patch cuts across (viewing someone else's turn on a shared session).
- #9641 open: dashboard reconnect test harness and detached-turn assertions (web test infra, not gateway code).
- #7221 merged (2026-06-07, in the pin): block observability telemetry from chat WS by default; the bus forwarding I reuse was deliberately filtered here.
- #10801 merged (in the pin): zerocode reload of notification-lag sessions without cancelling running turns (same area, client side).
- #10412 open: extract the atomic session-ownership claim into a shared `SessionBackend` contract (touches the ownership model); #10634 open: recover network-interrupted provider turns (provider-level, not WS); #9729 closed issue: zerocode multiple concurrent live sessions per chat pane.
- I found no issue or PR proposing multi-client observation, turn-frame fan-out or late-join replay on `/ws/chat`. This is a negative result from keyword searches only.

**Drift:** the pin is 3 commits behind the upstream head; **0** of them touch `crates/zeroclaw-gateway/` (so none touch `ws.rs`, `ws_approval.rs` or `crates/zeroclaw-infra/src/session_backend.rs`) or `observability/broadcast.rs`. `git apply --check zeroclaw-shared-turn.patch` at `afc47d33` succeeds (checked in a separate worktree; not built there).

**Judgement:** small and additive for Q1+Q2 (one file, ~150 lines, no new public surface, additive wire fields, reuses the bus and ring that exist); moderate once Q3 is included (persistence semantics, a flipped test, provisional rows in a provider-specific shape); Q4 beyond visible-to-all would be invasive (per-session approval registry and authorization). It would need tests and the small hardening items above before a PR; suggest asking first whether maintainers want multi-viewer sessions given #9355's per-pane exclusivity.

## Not reached
Lag/eviction behavior under a token-heavy turn; abrupt TCP drop of the owner; `/api/events` and `/api/events/history` leakage check; native tool-calling providers (stub only); non-sqlite backends; session deletion mid-turn; terminal `error` frame fan-out; liveness (Q6) rerun on the patched binary; approval timeout/deny/always; multiple agents; any variance data (each scenario ran once per variant); building or testing at the upstream head; the root crate's own tests.

## Deviations from the brief
1. **Branch:** the harness assigned `claude/charming-mccarthy-oyo4on`; I followed the brief's explicit branch `spike/ldv-208-zeroclaw-patch` and pushed only that.
2. **Q2 chose the bigger option** (replay buffer, ~30 lines) over the smaller persisted-partial route (0 extra lines after Q3), for the reason given in Q2.
3. **Ledger 114,713 bytes**, over the 100 KB target (under 128 KB hard); three rows are estimates.
4. **Test scope:** `cargo test -p zeroclaw-gateway --lib` with the crate's default features, not the root build's feature set, and lib tests only (638 tests); the crate's integration tests were not run. One existing test was edited (2 assertions) and is counted in the patch.
5. **The measured binary is pre-rustfmt;** the committed patch is rustfmt'd (the repo's fmt check failed on my first version). The rustfmt'd binary was smoke-tested on s1b, s3a and s4 only (`evidence/patched-final-smoke`), same frame sequences.
6. **Superseded attempts** are kept (see above); the first run of approval/extras with a shared run dir failed to connect and was discarded and rerun with one run dir per mode (its logs are not committed).
7. **Extras:** x1 and x2 rerun on the patched binary beyond the brief; x2 revealed attempts 2 and 3.
8. **Upstream reading** used WebFetch summaries for four PR/issue pages (see above) because direct reads of the repo through the GitHub tool were refused; no access was widened.
9. **Commit attribution:** the zeroclaw patch commit carries no attribution trailers (their CONTRIBUTING forbids them); the commits on this fork do.
10. Timing: first action 18:06:07Z; all measurements done by about 18:30Z (the 5m35s baseline build and the test compiles included); write-up and push followed.

## Files
`HANDOFF.md`; `zeroclaw-shared-turn.patch` and `.diffstat`; `scripts/` (driver, stub, harness reused unchanged; `frame-seq.mjs`, `msg-counts.mjs` new); `evidence/<variant>/<mode>/` (raw frames per socket, summaries, samples, snapshots, stub oracle, config, run-meta, cleanup-report); `evidence/tests/` (logs plus `summary.txt`); `evidence/build/` (tails); `evidence/read-ledger.tsv`; `evidence/upstream-head.txt`; `MANIFEST.sha256` (sha256 of every other committed file under this directory; not itself and not this commit).
