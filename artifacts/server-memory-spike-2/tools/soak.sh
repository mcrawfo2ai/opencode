#!/bin/bash
# soak.sh: RUN PORT OCBIN [HOURS=6 NDIR=8 EVERY=180 STARTENV=...]; all features via F_* env.
set -u
T=$(dirname $(readlink -f $0)); export S=${S:?}; export RUN=${RUN:?}; PORT=${PORT:?}; OCBIN=${OCBIN:?}
HOURS=${HOURS:-6}; NDIR=${NDIR:-8}; EVERY=${EVERY:-180}
NPROJ=$NDIR python3 $T/setup2.py > /dev/null || exit 1
source $T/env2.sh
mkdir -p $RUN/mem; export MEMDUMP_DIR=$RUN/mem
cd $RUN; nohup env ${STARTENV:-} $OCBIN serve --hostname 127.0.0.1 --port $PORT --print-logs --log-level INFO > $RUN/server.log 2>&1 < /dev/null &
P=$!; echo $P > $RUN/pid; sleep 10
B=http://127.0.0.1:$PORT
(while kill -0 $P 2>/dev/null; do python3 $T/probe.py $P tick $PORT >> $RUN/timeline.jsonl 2>/dev/null; sleep 60; done) &
memdump() { local before=$(ls $RUN/mem | grep -c '^done-'); kill -USR2 $P; for i in $(seq 1 240); do [ $(ls $RUN/mem | grep -c '^done-') -gt $before ] && break; sleep 0.5; done; sleep 5; cp $RUN/mem/mem-$((before+1)).json $RUN/mem/$1.json; python3 $T/probe.py $P "$1 postgc" $PORT >> $RUN/q.jsonl; }
end=$(( $(date +%s) + HOURS*3600 )); k=0; nextgc=$(( $(date +%s) + 1800 ))
memdump T0
while [ $(date +%s) -lt $end ]; do
  k=$((k+1)); d=$RUN/projects/p$(( (k-1) % NDIR + 1 )); script=go; [ $((k % 4)) -eq 0 ] && script=long
  t0=$(date +%s)
  sid=$(curl -s -X POST "$B/session?directory=$d" -H 'content-type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  body=$(python3 -c "import json,sys;print(json.dumps({'parts':[{'type':'text','text':'SCRIPT:'+sys.argv[1]+' SEQ:'+sys.argv[2]+' explore'}]}))" $script $k)
  curl -s -m 1800 -X POST "$B/session/$sid/message?directory=$d" -H 'content-type: application/json' -d "$body" > $RUN/last.json
  res=$(curl -s "$B/session/$sid/message?directory=$d" | python3 -c "
import json,sys,collections
c=collections.Counter()
for m in json.load(sys.stdin):
  for p in m['parts']:
    if p['type']=='tool': c[p['state']['status']]+=1
print(dict(c))")
  echo "$(date +%T) session $k $(basename $d) $script $sid $res" >> $RUN/sessions.log
  if [ $(date +%s) -ge $nextgc ]; then memdump "T$(( ( $(date +%s) - end + HOURS*3600 ) / 60 ))m"; nextgc=$(( nextgc + 1800 )); fi
  sleep $(( EVERY - ( $(date +%s) - t0 ) > 5 ? EVERY - ( $(date +%s) - t0 ) : 5 ))
done
memdump END; echo DONE >> $RUN/sessions.log
