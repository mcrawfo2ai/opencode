#!/bin/bash
# drive4.sh: RUN PORT OCBIN [F_*] [MAXN=20 CHECKS="1 5 10 20" IDLE=120 REVISIT=0 SSE=0 STARTENV=""]
set -u
T=$(dirname $(readlink -f $0)); export S=${S:?}; export RUN=${RUN:?}; PORT=${PORT:?}; OCBIN=${OCBIN:?}
MAXN=${MAXN:-20}; CHECKS=${CHECKS:-"1 5 10 20"}; IDLE=${IDLE:-120}; REVISIT=${REVISIT:-0}; SSE=${SSE:-0}
NPROJ=$MAXN python3 $T/setup2.py > /tmp/setup2.$$ 2>&1 || { cat /tmp/setup2.$$; exit 1; }
source $T/env2.sh
mkdir -p $RUN/mem; export MEMDUMP_DIR=$RUN/mem
cd $RUN; nohup env ${STARTENV:-} $OCBIN serve --hostname 127.0.0.1 --port $PORT --print-logs --log-level INFO > $RUN/server.log 2>&1 < /dev/null &
P=$!; echo $P > $RUN/pid; sleep 8
B=http://127.0.0.1:$PORT; OUT=$RUN/q.jsonl; : > $OUT
probe() { python3 $T/probe.py $P "$1" $PORT >> ${2:-$OUT}; }
(while kill -0 $P 2>/dev/null; do python3 $T/probe.py $P tick $PORT >> $RUN/timeline.jsonl 2>/dev/null; sleep 10; done) &
memdump() { local before=$(ls $RUN/mem | grep -c '^done-'); kill -USR2 $P; for i in $(seq 1 240); do [ $(ls $RUN/mem | grep -c '^done-') -gt $before ] && break; sleep 0.5; done; sleep 5; cp $RUN/mem/mem-$((before+1)).json $RUN/mem/$1.json; }
checkpoint() { probe "$1 active"; sleep $IDLE; probe "$1 idle"; memdump "$1"; probe "$1 postgc"; }
session() { # dir seq script
  local sid=$(curl -s -X POST "$B/session?directory=$1" -H 'content-type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  [ "$SSE" -gt 0 ] && ! grep -q "^$1\$" $RUN/sse.dirs 2>/dev/null && { for j in $(seq 1 $SSE); do (curl -sN "$B/global/event" > /dev/null 2>&1 &) ; done; echo "$1" >> $RUN/sse.dirs; }
  local body=$(python3 -c "import json,sys,os;b={'parts':[{'type':'text','text':'SCRIPT:'+sys.argv[1]+' SEQ:'+sys.argv[2]+' explore'}]};m=os.environ.get('MODEL');m and b.update(model={'providerID':'stub','modelID':m});print(json.dumps(b))" ${3:-go} $2)
  curl -s -m 1800 -X POST "$B/session/$sid/message?directory=$1" -H 'content-type: application/json' -d "$body" > $RUN/last.json
  local res=$(curl -s "$B/session/$sid/message?directory=$1" | python3 -c "
import json,sys,collections
c=collections.Counter()
for m in json.load(sys.stdin):
  for p in m['parts']:
    if p['type']=='tool': c[p['state']['status']]+=1
print(dict(c))")
  echo "$(date +%T) session $2 $(basename $1) $sid $res" >> $RUN/sessions.log
}
sleep 15; probe "N=0 boot"; sleep $IDLE; probe "N=0 idle"; memdump N0; probe "N=0 postgc"
for k in $(seq 1 $MAXN); do
  session $RUN/projects/p$k $k ${SCRIPT:-go}
  [[ " $CHECKS " == *" $k "* ]] && checkpoint "N=$k"
done
for r in $(seq 2 $((REVISIT+1))); do
  for k in $(seq 1 $MAXN); do session $RUN/projects/p$k $((r*100+k)) ${SCRIPT:-go}; done
  checkpoint "R$r"
done
echo DONE >> $RUN/sessions.log
