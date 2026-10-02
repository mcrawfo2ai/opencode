#!/bin/bash
# LDV-199 case-4 outer shell fixture. Runs inside the native PTY with job control (set -m) so a foreground child
# gets its own process group. Control plane: gate/ack files. Oracle is appended through a separate path (builtins only).
FX="$1"; NODE="$2"; FXJS="$3"; CHILD="$4"
ORACLE="$FX/oracle.bin"
OLEN=0
ms() { echo $(( ${EPOCHREALTIME/./} / 1000 )); }
ack() { printf '{"name":"%s","wall_ms":%s,"pid":%s,"oracle_len":%s,"extra":%s}\n' "$1" "$(ms)" "$$" "$OLEN" "${2:-null}" > "$FX/acks/$1.tmp"; mv "$FX/acks/$1.tmp" "$FX/acks/$1.json"; }
mkfifo "$FX/wait.fifo"; exec 3<>"$FX/wait.fifo"
gate() { while [ ! -e "$FX/gates/$1" ]; do read -t 0.01 -u 3 _x; done; }
emit() { local s; printf -v s "$1"; printf '%s' "$s" >> "$ORACLE"; OLEN=$(( OLEN + ${#s} )); printf '%s' "$s"; }

saved=$(stty -g)
stty -a > "$FX/mode-before.txt" 2>&1
stty -echo -opost
stty -a > "$FX/mode-after.txt" 2>&1
set -m
printf '{"saved_stty_g":"%s","job_control_flags":"%s","pid":%s,"ppid":%s}\n' "$saved" "$-" "$$" "$PPID" > "$FX/mode.json"
emit 'READY shell\n'
ack ready
gate start
emit 'START shell\n'
ack started
"$NODE" "$FXJS" "$CHILD"
code=$?
echo "$code" > "$FX/child-code.txt"
emit "CHILD-CODE-$code\n"
emit 'OUTER-ALIVE\n'
ack alive "{\"child_code\":$code}"
gate outer
emit 'OUTER-EXIT\n'
ack exit-stage '{"code":0}'
exit 0
