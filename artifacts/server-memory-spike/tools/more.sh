#!/bin/bash
# more.sh: against running server (RUN, PORT), run one session in each of p1..p$MAXN again, then idle and snap
source $(dirname $0)/env.sh; T=$(dirname $0); P=$(cat $RUN/pid); B=http://127.0.0.1:$PORT
for k in $(seq 1 ${MAXN:-20}); do d=$RUN/projects/p$k
  sid=$(curl -s -X POST "$B/session?directory=$d" -H 'content-type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  curl -s -X POST "$B/session/$sid/message?directory=$d" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"explore"}]}' > /dev/null
done
$T/snap.sh $P "$LABEL active" >> $RUN/q1.jsonl; sleep ${IDLE:-120}; $T/snap.sh $P "$LABEL idle" >> $RUN/q1.jsonl
before=$(ls $RUN/mem | grep -c '^done-'); kill -USR2 $P; sleep 8; cp $RUN/mem/mem-$((before+1)).json $RUN/mem/$LABEL.json; $T/snap.sh $P "$LABEL postgc" >> $RUN/q1.jsonl
