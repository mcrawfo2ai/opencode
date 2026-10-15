#!/bin/bash
# drive.sh MODE  (MODE=dirs: one session per fresh dir; MODE=same: all sessions in p1)
# env: RUN, OCBIN, IDLE (s), CHECKS (list of N)
MODE=${1:-dirs}
source $(dirname $0)/env.sh
T=$(dirname $0)
IDLE=${IDLE:-120}; CHECKS=${CHECKS:-"1 5 10 20"}; MAXN=${MAXN:-20}
$T/${SETUP:-setup.sh} >/dev/null
mkdir -p $RUN/mem; export MEMDUMP_DIR=$RUN/mem
$T/start.sh $STARTENV >/dev/null; P=$(cat $RUN/pid)
OUT=$RUN/q1.jsonl; : > $OUT
(while kill -0 $P 2>/dev/null; do $T/snap.sh $P tick >> $RUN/timeline.jsonl; sleep 10; done) &
memdump() { local before=$(ls $RUN/mem | grep -c '^done-'); kill -USR2 $P; for i in $(seq 1 120); do [ $(ls $RUN/mem | grep -c '^done-') -gt $before ] && break; sleep 0.5; done; cp $RUN/mem/mem-$((before+1)).json $RUN/mem/$1.json; }
sleep 15
$T/snap.sh $P "N=0 boot" >> $OUT
sleep $IDLE; $T/snap.sh $P "N=0 idle" >> $OUT; memdump N0; $T/snap.sh $P "N=0 postgc" >> $OUT
for k in $(seq 1 $MAXN); do
  d=$RUN/projects/p$k; [ "$MODE" = same ] && d=$RUN/projects/p1
  if [ "$MODE" = instonly ]; then curl -s "http://127.0.0.1:${PORT:-4096}/session?directory=$d" > /dev/null; curl -s "http://127.0.0.1:${PORT:-4096}/config?directory=$d" > /dev/null; curl -s "http://127.0.0.1:${PORT:-4096}/agent?directory=$d" > /dev/null; echo "inst $k" >> $RUN/sessions.log; else
  sid=$(curl -s -X POST "http://127.0.0.1:${PORT:-4096}/session?directory=$d" -H 'content-type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  curl -s -X POST "http://127.0.0.1:${PORT:-4096}/session/$sid/message?directory=$d" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"explore"}]}' > $RUN/last.json
  ntool=$(curl -s "http://127.0.0.1:${PORT:-4096}/session/$sid/message?directory=$d" | python3 -c "import json,sys;print(sum(1 for m in json.load(sys.stdin) for p in m['parts'] if p['type']=='tool' and p['state']['status']=='completed'))")
  echo "session $k $sid tools=$ntool" >> $RUN/sessions.log; fi
  if [[ " $CHECKS " == *" $k "* ]]; then
    $T/snap.sh $P "N=$k active" >> $OUT
    sleep $IDLE; $T/snap.sh $P "N=$k idle" >> $OUT
    memdump N$k; $T/snap.sh $P "N=$k postgc" >> $OUT
  fi
done
echo DONE >> $RUN/sessions.log
