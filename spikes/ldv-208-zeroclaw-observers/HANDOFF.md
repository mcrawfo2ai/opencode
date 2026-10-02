# LDV-208 observers spike: who receives a zeroclaw turn's stream

Throwaway measurements and scripts only. No production code, no PR, no merge. Written by a single cloud seat (no sub-agents). Model identity not recorded here.

## Provenance
- Fork: https://github.com/mcrawfo2ai/opencode (push remote owner verified `mcrawfo2ai`; nothing written to `internetisalie`; every other branch left alone).
- Branch: `spike/ldv-208-zeroclaw-observers`, created from `d08209ca6493eff16f24a3c37ca926995b4f39a3`. Head = the commit containing this file (SHA reported in chat).
- Under test: zeroclaw `74362c2d6bfeaa81cc611e75cd07b7f3afd52d64` (v0.8.5), cloned and checked out at that exact commit (pin available, no substitution).
- Build: `cargo build --bin zeroclaw --no-default-features --features agent-runtime,gateway`, dev profile, 4m27s, exit 0; binary sha256 `7a9b5109…dd58` (`evidence/build-summary.txt`).
- Platform: Linux 6.18.44 x86_64, 4 cores, 16 GB; rustc/cargo 1.97.0; bun 1.3.14; python 3.11.15; node 22.22.0.
- Reused from `spike/ldv-208-zeroclaw` unchanged: `scripts/stub_provider.py` (sha256 `37000…b670`) and `scripts/harness.mjs`; the config is that spike's recipe with the port and stub URI changed.
- Isolation: loopback only, private run dir with fixture HOME/config/data/workspace; children started under `env -i` with allowlist PATH, HOME(fixture), LANG, NO_PROXY, RUST_BACKTRACE (+ZEROCLAW_CONFIG_DIR/DATA_DIR for the gateway). No cloud/GitHub/provider secrets, no proxy settings. Stub provider only.
- Runs (PIDs and start-ticks are in each `run-meta.json`; at the end each process was signalled only after `/proc/<pid>/stat` start-ticks matched, and `alive_after=false` for all, see each `cleanup-report.json`):

| run | evidence dir | gateway pid / start-ticks / port | stub pid / start-ticks / port | config |
|---|---|---|---|---|
| main (Q1-Q4, Q6) | `evidence/main` | 6246 / 36082 / 38331 | 6245 / 36071 / 45835 | file_read auto-approved |
| approval (Q5) | `evidence/approval` | 6820 / 47412 / 44003 | 6819 / 47402 / 45789 | `always_ask=["file_read"]` |
| approval attempt 1 (superseded, kept) | `evidence/approval-attempt1-no-gate` | 6512 / 43110 | 6490 | file_read removed from `auto_approve` only; did NOT gate (see deviations) |
| extra x2 | `evidence/extra-main` | 7274 / 58517 | see its `run-meta.json` | as main |
| extra x1 | `evidence/extra-approval` | 7239 / 57796 | see its `run-meta.json` | as approval |

## Method
`scripts/run-observers.mjs` (run with bun) opens real WebSockets `/ws/chat?agent=default&session_id=S` (the fixture has one agent, `default`) and prompts with `{"type":"message","content":..}`. Turn pacing is by the stub's own gates (`g1` before the first chunk, `g2` before the tool call, `g3` before the final text), driven from the stub's log, never from a socket, so a closed socket cannot stall the run. Per socket, every frame is appended to `<scenario>.<sock>.raw.jsonl` as `{t_ms, wall_ms, ev, data}` **before** parsing (`ev`: open/message/sent/close/error; defensive redaction regex only, nothing matched). `<scenario>.summary.json` holds the parsed per-socket sequence, close codes, message snapshots, state samples and the stub log slice; `<scenario>.stub-slice.json` is the stub's own oracle for what the model side saw. A sampler polls `/api/sessions/running` and `/api/sessions/S/state` every ~500 ms during every scenario (`*.samples.json`, collapsed in `samples-digest.txt`). `scripts/show.mjs` and `scripts/samples-digest.mjs` only print these files. Times below are the driver's monotonic ms; stub times are on the stub's own clock and are never compared with them.

Frame shorthand: SS=`session_start`, CH=`chunk`, TC=`tool_call`, TR=`tool_result`, DN=`done`. A normal turn is CH, TC, TR, CH, DN.

## Read ledger
`evidence/read-ledger.tsv`: 49 rows, **95,884 bytes** (target 100 KB, hard 128 KB). Rows before the helper existed (first listings, first 12,000 bytes of the prior HANDOFF, prior file listing) and one row for other unlogged tool output are estimates, labelled as such. Separately disclosed, not counted: the brief (~5 KB) and the injected repo `AGENTS.md` (~9 KB). Not read at all: zeroclaw source beyond bounded ranges (see "Source cited"), build log beyond its last 2 lines, any raw frame file whole (parsed by script).

## Summary
| # | question | classification | one line |
|---|---|---|---|
| 1 | second observer | observed (adverse for observing) | WS-B gets only `session_start`; never the turn, whether attached before, mid-turn or after `done`. |
| 2 | prompt from second socket | observed | The stream goes only to the socket that sent the prompt; A sees nothing of B's turn. History holds both turns in order. |
| 3 | owner drop mid-turn | observed | The turn continues unattended and completes; nothing persists until it ends; B gets nothing. |
| 4 | reconnect mid-turn | observed (adverse) | A' gets `session_start` only: no replay, no remainder. The turn completes for nobody. |
| 5 | approval round trip | observed | `approval_request` goes only to the prompting socket; B's `approval_response` is rejected with an `error` frame; A's is honoured. |
| 6 | liveness signal | observed | Both endpoints show the turn as busy for its full duration, with a `turn_id`. |

## Q1. Second observer (A and B on the same session and agent)
- **1a, B attached before the prompt** (`main/s1a_both_before`). Prompt on A, gates held 1.5 s / 1 s / 1 s.
  - A (6): SS@242, CH@2559, TC@4369, TR@4382, CH@5476, DN@5486.
  - B (1): SS@594. No further frame during the turn or 1.5 s after `done`. B was not closed or errored; it was closed by the driver (code 1000).
  - Messages API: 0 messages before the prompt, after the first chunk and before the final chunk; 4 after `done`.
- **1b, B attached mid-turn** (after A's first chunk, stub held at g2) (`main/s1b_B_midturn`).
  - A (6): SS@7489, CH@7946, TC@9604, TR@9615, CH@10713, DN@10714.
  - B (1): SS@8750 with `message_count:0, resumed:false`. Nothing else, including nothing of the chunk it missed and nothing of the rest.
- **1c, B attached after `done`** (`main/s1c_B_after_done`).
  - A (6) as above. B (1): SS@15241 with `message_count:4, resumed:true`. No replay of the 5 turn frames over the following ~2.3 s. The 4 persisted messages are reachable only via `GET /api/sessions/S/messages`.
- Not seen in any of the three: error frames, takeover, or WS-A being closed.

## Q2. Prompting from the second socket (`main/s2_prompt_from_B`)
Turn 1 on A, then A idle, then turn 2 on B; both attached throughout.
- Frame counts before turn 2: A 6, B 1. After: A 6, B 6.
- A: SS, then turn 1's five frames only. B: SS@18098, then turn 2's CH@21082, TC@21890, TR@21903, CH@21995, DN@21999. A received nothing of turn 2 and B nothing of turn 1.
- History (`GET /api/sessions/S/messages`): 4 messages after turn 1, 8 after turn 2, in order: user1, assistant(marker+tool call text), user(tool results), assistant(final), then the same four for turn 2. The user text carries a gateway-added `[CURRENT DATE & TIME: ...]` prefix. Every message has the same `created_at` and it changes on each persist (`…17:36:28.566` after turn 1; all 8 are `…17:36:31.092` after turn 2), so `created_at` is the last-persist time, not per-message.

## Q3. Owner drop mid-turn
Prompt on A, release g1 (first chunk arrives), close A (client close, code 1000), hold g2 for about 4.5 s after the drop, then release g2 and g3.
- **3a, no other socket** (`main/s3a_owner_drop`). A (2): SS@23980, CH@24438, closed@25238.
  - Turn: **continued**. After g2 was released the stub saw the gateway's phase-2 request (tool executed, `g3` reached), g3 released, final text emitted (`stub-slice.json`). Not aborted, not hung, within the ~6 s observed.
  - `/messages`: 0 messages at +1 s, +2 s and just before g3 (so no user message and no partial text while running); 4 after the turn ended (user, assistant with the chunk plus tool call, tool results, final).
  - `/api/sessions/S/state`: `running` with `turn_id` for the whole gap, including after the drop (10 samples, 24831..29355 ms); `idle` from 29857. `/api/sessions/running` listed S throughout and was empty after.
- **3b, B attached** (`main/s3b_owner_drop_B`). A (2) as 3a. B (1): SS only. B received nothing at the drop, during the continuing turn, or at its end. Persisted and state readings identical to 3a (4 messages at the end, 0 before).

## Q4. Reconnect mid-turn on the same session_id (`main/s4_reconnect`)
Prompt on A, g1 released (CH), A closed, A' opened 0.85 s later on the same S, g2 held 1.5 s then released, g3 released.
- A (2): SS@39615, CH@40075. A' (1): SS@41380 with `message_count:0, resumed:false` (nothing yet persisted).
- A' received **nothing** after SS: no replay, no remaining chunk/tool/done frames. Stub oracle shows the turn finished (phase-2 request, final emitted); `/messages` before g3: 0; final: 4 (full turn). The turn completed and its output reached no socket.

## Q5. Approval round trip (`approval/s5_approval_answer_from_{A,B}`)
Config `always_ask=["file_read"]` (the first attempt without it did not gate, see deviations). A and B attached; prompt on A.
- Request: `{"type":"approval_request","request_id":…,"tool":"file_read","arguments_summary":"path: …/fixture.txt","timeout_secs":120}`. Frame order on A: SS, CH, **approval_request**, then (after the answer) TC, TR, CH, DN. **B never received the request.** In the answer-from-A run B received 1 frame (SS only); in the answer-from-B run it received SS plus the `error` frame described below.
- **Answered from A** (`answer_from_A`): approval_response `{"type":"approval_response","request_id":…,"decision":"approve"}` sent 45 ms after the request frame (request@1842, response@1887); TC arrived 3 ms after the response (@1890), then TR, CH, DN; persisted 4 messages.
- **Answered from B** (`answer_from_B`): B sent the same frame. B received `{"type":"error","message":"Unsupported message type \"approval_response\". Send {\"type\":\"message\",\"content\":\"your text…"}`. The turn made no progress for 7 s (stub never saw phase 2), the request stayed pending, then the driver's control answer from A was accepted and the turn completed (TC/TR/CH/DN on A). So only the socket that owns the turn may answer; B cannot.

## Q6. Liveness signal (`main/s6_liveness`, also every other scenario's `samples-digest.txt`)
Sampler every ~500 ms during a turn gated 3 s before g1, 3 s after the first chunk, 3 s before g3.
- Before the first prompt: `/api/sessions/running` = `{"sessions":[]}`; `/state` = **404 `Session not found`** (opening the WS creates no gateway-visible session; 3 samples, then one `idle` sample right after the prompt).
- During the turn (19 samples, 48357..57394 ms, the whole gated span): `/state` = `{"session_id":…,"state":"running","turn_id":"…","turn_started_at":"…"}`; `/running` = `{"sessions":[{"created_at":…,"last_activity":…,"message_count":0,"session_id":…}]}`. The row shows `message_count:0` and an unchanged `last_activity` for the whole turn.
- After `done`: `/state` = `idle`; `/running` = `[]`.
- Both signals showed busy throughout, including after the owner dropped (Q3).

## Extras (outside the brief, labelled; separate evidence dirs)
- **x1, owner closes while an approval is pending** (`extra-approval/x1_drop_during_approval`). A received SS, CH, approval_request, then was closed. B (attached) received SS only. A was closed 45 ms after the request frame arrived. The runtime then denied the tool without waiting for the prompt timeout: on the stub's clock the phase-2 request arrived 96 ms after the stub emitted the tool call, far inside `timeout_secs=120`; the persisted tool-result message reads `Tool call not executed: 'file_read' requires approval and no operator decision was available, so the runtime denied it by policy. This was not a user's decision.` The turn finished with a final message (4 messages persisted).
- **x2, B prompts while A's turn is in flight** (`extra-main/x2_prompt_B_inflight`). B's prompt did **not** reach the stub while A's turn was gated (`second_request_reached_stub_while_A_gated: seen=false` after 2.5 s); it arrived only after A's turn finished, so it queues behind it. A got only its own 6 frames; B got SS plus its own turn's 5 frames. History: 8 messages, A's turn then B's.

## Can a second client observe a turn it did not start?
No, not through the WebSocket. In every arrangement measured (attached before the prompt, attached mid-turn, attached after `done`, reconnecting under the same id, prompting from the second socket), turn frames (`chunk`, `tool_call`, `tool_result`, `done`, `approval_request`) were delivered only to the socket that sent the prompt; the other socket received its own `session_start` and nothing else: no error, no takeover, no close, no replay. A socket that attaches mid-turn does not receive the remainder, and the dropped owner's turn runs to completion with its output going to no socket (Q3, Q4). What a second client can see over HTTP is liveness (`/api/sessions/S/state` shows `running` plus `turn_id` and `/api/sessions/running` lists the session for the whole turn) and, only after the turn ends, the full persisted transcript via `/messages` (written wholesale at turn end, not at prompt admission; no user message or partial text beforehand). A late-attaching socket learns only `message_count`/`resumed` in `session_start`. So an OpenCode-style shim that wants several clients to watch one turn must be the single prompting socket and fan out the frames itself; the gateway itself will not. Approvals follow the same ownership rule: the request goes to the owner only, a non-owner's answer is rejected, and if the owner drops the request is denied immediately by policy rather than waiting out its timeout.

## Source cited (interpretation only; every claim above is measured)
At zeroclaw `74362c2d`, `crates/zeroclaw-gateway/src/ws.rs`:
- `detach_mid_turn` L1314-1327 and its use at L1871, 1878, 1982, 1989, 2072: logs "WebSocket client detached mid-turn; turn continues unattended" and drains the parked approvals (consistent with Q3 and x1).
- L1717-1719 comment: a socket that connects while a detached turn runs seeds history from a transcript that has since moved (matches x2's queueing and the `resumed`/`message_count` readings).
- L956-962: a shared broadcast channel forwards events whose `session_id` matches to every socket on that session; none reached B in any turn here (cron/heartbeat-style events were not exercised).
- L840-870: `approval_response` parsing; L960-985: `approval_request` emission.

## Not reached
- Abrupt TCP drop or process kill of the owner (only client-initiated close, code 1000, was measured).
- Hang horizon: the longest observed gap after an owner drop was about 6 s; no gateway-side timeouts beyond that were probed.
- Approval timeout expiry (`timeout_secs=120` not waited), `decision:"deny"`/`"always"`, SOP approval frames.
- Repeat runs: each scenario ran once; no variance data.
- `/api/events` SSE during these turns (covered by the prior spike), `/webhook`, multiple agents, other session ids on one agent.
- Delete/recreate of a session with attached observers.

## Deviations from the brief
1. **Approval attempt 1 did not gate.** Removing `file_read` from `auto_approve` was not enough: `file_read` ran with no `approval_request`. (`crates/zeroclaw-config/src/schema.rs` L13802-13808, `ensure_default_auto_approve`, merges the built-in defaults back; found by a bounded grep after the failure, not before.) That attempt's driver also left its turn gated until cleanup. Its evidence is kept in `approval-attempt1-no-gate/`; the reported Q5 result is the rerun with `always_ask=["file_read"]`.
2. Two extra scenarios (x1, x2) beyond the brief, kept separate; they used time after Q1-Q6 were done.
3. The cloud harness assigned a default working branch for this session; I followed the brief's explicit branch and pushed only `spike/ldv-208-zeroclaw-observers`.
4. Read ledger rows for the first few commands and for unlogged output are estimates.
5. Timing: first action 17:30:20Z; all measurements finished about 17:40Z, inside the 30-minute box (the build took 4m27s of that); this write-up and the push followed.
6. Redaction was a defensive regex applied on write; a pattern scan of the evidence found only the gateway banner's literal text "bearer token required", no credentials. Gateway stdout is the short startup banner only (582 bytes) (default log level; the "detached" log line did not appear there).
7. The driver is shared across modes (`main`, `approval`, `extra-main`, `extra-approval`); the first approval run used the driver before its two-line fix (config `always_ask`; release a stuck g3 when no request appears). The committed script is the final version.

## Files
`scripts/` (driver, helpers, reused stub and harness), `evidence/<run>/` (raw frames per socket, summaries, samples, stub oracle, config, run-meta, cleanup-report, gateway banner), `evidence/build-summary.txt`, `evidence/read-ledger.tsv`, `MANIFEST.sha256` (sha256 of every other committed file under this directory; it does not list itself or this commit).
