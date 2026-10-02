#!/bin/bash
# LDV-199 gaps PTY fixture. Runs INSIDE the native PTY, non-interactive (no prompts).
# usage: fixture.sh FXDIR      (reads FXDIR/plan.txt; payload files are immutable inputs in FXDIR/payload/)
# plan ops:  mode | ack STAGE | gate NAME | emit PAYLOADFILE STAGE | exit CODE STAGE
# Control plane is filesystem only (gate files in, ack files out); nothing is ever read from the PTY.
# Every byte emitted to the PTY goes through `tee -a ORACLE < PAYLOAD`: PTY stdout and the oracle receive the same
# immutable payload bytes; the tee status is checked directly (no pipeline). Nothing else writes to PTY stdout.
FX="$1"
PLAN="$FX/plan.txt"; ORACLE="$FX/oracle.bin"; ACKS="$FX/acks"; GATES="$FX/gates"; LOG="$FX/stage.log"; PAYLOAD="$FX/payload"
us() { printf '%s' "${EPOCHREALTIME/./}"; }
log() { printf '%s %s\n' "$(us)" "$*" >> "$LOG" || exit 89; }
fail() { log "FAIL $1"; exit "${2:-99}"; }
mkfifo "$FX/wait.fifo" || fail "mkfifo" 90
exec 3<>"$FX/wait.fifo" || fail "fifo-open" 91
ack() { # $1 stage  $2 extra JSON fields (with leading comma) ; oracle_len measured AFTER the stage's emission succeeded
  local len
  len=$(stat -c %s "$ORACLE") || fail "stat-oracle" 92
  printf '{"stage":"%s","wall_us":%s,"pid":%s,"oracle_len":%s%s}\n' "$1" "$(us)" "$$" "$len" "$2" > "$ACKS/$1.tmp" || fail "ack-write $1" 93
  mv "$ACKS/$1.tmp" "$ACKS/$1.json" || fail "ack-mv $1" 93
  log "ack $1 oracle_len=$len"
}
gate() { while [ ! -e "$GATES/$1" ]; do read -t 0.01 -u 3 _x; done; log "gate-passed $1"; }
emit() { # $1 payload file name, $2 stage
  local f="$PAYLOAD/$1" rc plen
  [ -r "$f" ] || fail "payload-missing $1" 94
  tee -a "$ORACLE" < "$f"
  rc=$?
  [ "$rc" -eq 0 ] || fail "tee rc=$rc stage=$2" 95
  plen=$(stat -c %s "$f") || fail "stat-payload" 96
  ack "$2" ",\"payload\":\"$1\",\"payload_len\":$plen"
}
modeset() { # terminal mode is saved/verified through files, never through PTY stdout
  stty -g > "$FX/mode.saved" || fail "stty-g" 97
  stty -a > "$FX/mode.before.txt" || fail "stty-a-before" 97
  stty -echo -opost || fail "stty-set" 98
  stty -a > "$FX/mode.after.txt" || fail "stty-a-after" 98
  stty size > "$FX/mode.size.txt" || fail "stty-size" 98
  grep -Eq '(^|[ ;])-echo([ ;]|$)' "$FX/mode.after.txt" || fail "echo-not-disabled" 98
  grep -Eq '(^|[ ;])-opost([ ;]|$)' "$FX/mode.after.txt" || fail "opost-not-disabled" 98
  compgen -e > "$FX/env-names.raw" || fail "compgen" 98
  LC_ALL=C sort -o "$FX/env-names.txt" "$FX/env-names.raw" || fail "sort" 98
  log "mode verified"
}
log "fixture start pid=$$"
while read -r -u 4 op a b; do
  case "$op" in
    mode) modeset ;;
    ack) ack "$a" "" ;;
    gate) gate "$a" ;;
    emit) emit "$a" "$b" ;;
    exit) ack "$b" ",\"code\":$a"; log "exiting $a"; exit "$a" ;;
    *) fail "bad-plan-op $op" 99 ;;
  esac
done 4< "$PLAN"
fail "plan-ended-without-exit" 99
