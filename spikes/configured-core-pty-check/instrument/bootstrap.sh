#!/usr/bin/env bash
# Bounded isolated bootstrap of the real v2 server with the pinned plugin configured as a local directory.
# Secrets live only in shell memory; every byte written to disk passes the redact filter first.
set -u
SPIKE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$SPIKE/../.." && pwd)
BUN_DIR=${BUN_DIR:?}
PLUGIN_DIR=${PLUGIN_DIR:?}          # pinned opencode-pty checkout
PLUGIN_SUBDIR=${PLUGIN_SUBDIR:-src/v2}
PTY_BIN=${PTY_BIN:?}
RUN=${RUN_ROOT:?}
EVID=${EVID:?}
mkdir -p "$RUN"/{home,config,data,state,cache,runtime,project,tmp,pty} "$EVID"
chmod 700 "$RUN"
PASS=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
PORT=$("$BUN_DIR/bun" -e 'const s=Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});console.log(s.port);s.stop(true)')
redact() { sed -u -e "s#$PASS#<PASSWORD>#g" -e "s#$RUN#<RUN>#g" -e "s#$PLUGIN_DIR#<PLUGIN>#g" -e "s#$REPO#<REPO>#g"; }
CONFIG=$(printf '{"plugins":[{"package":"%s","options":{"serverUrl":"http://127.0.0.1:%s"}},"%s"]}' "$PLUGIN_DIR/$PLUGIN_SUBDIR" "$PORT" "$SPIKE/probe-plugin")
echo "config_shape: $CONFIG" | redact > "$EVID/config-shape.txt"
echo "port=$PORT" > "$EVID/port.txt"
T0=$(date +%s.%N)
cd "$REPO/packages/cli"
env -i HOME="$RUN/home" PATH="$BUN_DIR:/usr/bin:/bin" TMPDIR="$RUN/tmp" \
  XDG_CONFIG_HOME="$RUN/config" XDG_DATA_HOME="$RUN/data" XDG_STATE_HOME="$RUN/state" \
  XDG_CACHE_HOME="$RUN/cache" XDG_RUNTIME_DIR="$RUN/runtime" XDG_CONFIG_DIRS="$RUN/config" XDG_DATA_DIRS="$RUN/data" \
  OPENCODE_PASSWORD="$PASS" OPENCODE_SERVER_PASSWORD="$PASS" OPENCODE_CONFIG_CONTENT="$CONFIG" \
  OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
  OPENCODE_DISABLE_FILEWATCHER=1 OPENCODE_DB="$RUN/data/opencode.db" OPENCODE_PTY_BIN="$PTY_BIN" \
  OPENCODE_PTY_RUNTIME_DIR="$RUN/pty" \
  "$BUN_DIR/bun" src/index.ts serve --hostname 127.0.0.1 --port "$PORT" \
  > >(redact > "$EVID/stdout.log") 2> >(redact > "$EVID/stderr.log") < /dev/null &
PID=$!
cd "$RUN/project"
START=$(awk '{print $22}' /proc/$PID/stat)
{ echo "pid=$PID"; echo "starttime_ticks=$START"; echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)";
  echo "exe=$(readlink /proc/$PID/exe | redact)"; echo "exe_sha256=$(sha256sum /proc/$PID/exe | cut -c1-64)"; } > "$EVID/host-identity.txt"
ready=no
for i in $(seq 1 60); do grep -q 'server listening on' "$EVID/stdout.log" 2>/dev/null && { ready=yes; break; }; sleep 0.5; done
echo "ready=$ready elapsed_s=$(echo "$(date +%s.%N) - $T0" | bc)" >> "$EVID/host-identity.txt"
# OS-level listener ownership: the LISTEN socket inode on PORT must be an fd of PID.
HEXPORT=$(printf '%04X' "$PORT")
INODES=$(awk -v p=":$HEXPORT" '$2 ~ p"$" && $4=="0A" {print $10}' /proc/net/tcp)
OWNED=no
for ino in $INODES; do ls -l /proc/$PID/fd 2>/dev/null | grep -q "socket:\[$ino\]" && OWNED=yes; done
echo "listen_inodes=$(echo $INODES) listener_owned_by_pid=$OWNED" >> "$EVID/host-identity.txt"
sleep 3
ps -o pid,ppid,lstart,args --ppid $PID 2>/dev/null | redact > "$EVID/children.txt"
pgrep -a -f opencode-pty | redact > "$EVID/native-procs.txt"
# Fence then intentional server end.
NOW=$(awk '{print $22}' /proc/$PID/stat 2>/dev/null)
if [ "$NOW" = "$START" ]; then kill -TERM $PID; echo "sigterm_sent=yes fence=match" >> "$EVID/host-identity.txt"
else echo "sigterm_sent=no fence=mismatch_or_gone cleanup=unknown" >> "$EVID/host-identity.txt"; fi
for i in $(seq 1 20); do kill -0 $PID 2>/dev/null || break; sleep 0.5; done
kill -0 $PID 2>/dev/null && echo "host_survived_sigterm=yes" >> "$EVID/host-identity.txt" || echo "host_exited=yes" >> "$EVID/host-identity.txt"
wait $PID; echo "host_exit_status=$?" >> "$EVID/host-identity.txt"
sleep 1; pgrep -a -f opencode-pty | redact > "$EVID/native-procs-after.txt"
unset PASS
