#!/bin/bash
# ptyrepro.sh : fresh server on PORT; create K ptys whose shell exits; measure fds/threads; then delete them.
source $(dirname $0)/env.sh; T=$(dirname $0); K=${K:-10}
$T/setup.sh >/dev/null; P=$($T/start.sh); B=http://127.0.0.1:$PORT; D=$RUN/projects/p1
sleep 5; $T/snap.sh $P "boot"
curl -s "$B/pty?directory=$D" >/dev/null; sleep 2; $T/snap.sh $P "instance loaded, 0 pty"
ids=()
for i in $(seq 1 $K); do
  id=$(curl -s -X POST "$B/pty?directory=$D" -H 'content-type: application/json' -d '{"command":"/bin/sh","args":["-c","echo hello; sleep ${SLP:-1}; exit 3"]}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  ids+=($id)
done
sleep 1; $T/snap.sh $P "$K ptys running"
sleep $((SLP+5)); $T/snap.sh $P "$K ptys exited"
echo "children alive: $(pgrep -P $P | wc -l); zombies: $(ps --ppid "$P" -o stat= | grep -c Z)"
echo "legacy GET /pty running count: $(curl -s "$B/pty?directory=$D" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')"
curl -s "$B/api/pty?directory=$D" | python3 -c 'import json,sys;d=json.load(sys.stdin); d=d.get("data",d) if isinstance(d,dict) else d; print("api/pty sessions:", [(x["status"],x.get("exitCode")) for x in d][:3], "... total", len(d))'
for id in "${ids[@]}"; do curl -s -o /dev/null -w "%{http_code} " -X DELETE "$B/api/pty/$id?directory=$D"; done; echo
sleep 2; $T/snap.sh $P "after DELETE /api/pty of all $K"
curl -s -X POST "$B/instance/dispose?directory=$D" >/dev/null; sleep 3; $T/snap.sh $P "after POST /instance/dispose"
ls -l /proc/$P/fd | grep -E "ptmx|pts" | head -8
kill $P
