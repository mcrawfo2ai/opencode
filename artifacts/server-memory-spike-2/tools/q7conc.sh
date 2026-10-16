#!/bin/bash
# q7conc.sh: RUN PORT OCBIN [NC=8 SCRIPT MODEL]: all features + big files; NC concurrent sessions on NC fresh dirs.
set -u
T=$(dirname $(readlink -f $0)); export S=${S:?}; export RUN=${RUN:?}; PORT=${PORT:?}; OCBIN=${OCBIN:?}; NC=${NC:-8}
F_OPENCODE=1 F_LSP=1 F_PLUGINS=1 F_PROVIDERS=1 F_BIG=1 NPROJ=$NC python3 $T/setup2.py > /dev/null || exit 1
source $T/env2.sh; mkdir -p $RUN/mem; export MEMDUMP_DIR=$RUN/mem
cd $RUN; nohup env ${STARTENV:-} $OCBIN serve --hostname 127.0.0.1 --port $PORT --print-logs --log-level INFO > $RUN/server.log 2>&1 < /dev/null &
P=$!; echo $P > $RUN/pid; sleep 10; B=http://127.0.0.1:$PORT
$T/fast.sh $P $RUN/fast.txt &
python3 $T/probe.py $P "boot" $PORT >> $RUN/q.jsonl
pids=()
for k in $(seq 1 $NC); do (
  d=$RUN/projects/p$k
  sid=$(curl -s -X POST "$B/session?directory=$d" -H 'content-type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  body=$(python3 -c "import json,sys,os;b={'parts':[{'type':'text','text':'SCRIPT:'+sys.argv[1]+' SEQ:'+sys.argv[2]+' TURNS:'+os.environ.get('TURNS','40')+' explore'}]};m=os.environ.get('MODEL');m and b.update(model={'providerID':'stub','modelID':m});print(json.dumps(b))" ${SCRIPT:-bigpatch} $k)
  curl -s -m 1800 -X POST "$B/session/$sid/message?directory=$d" -H 'content-type: application/json' -d "$body" > /dev/null
  echo "$(date +%T) session $k $sid" >> $RUN/sessions.log ) &
  pids+=($!)
done
wait ${pids[@]}
python3 $T/probe.py $P "all done active" $PORT >> $RUN/q.jsonl; sleep 120
python3 $T/probe.py $P "idle 120s" $PORT >> $RUN/q.jsonl; kill -USR2 $P; sleep 20
python3 $T/probe.py $P "postgc" $PORT >> $RUN/q.jsonl; echo DONE >> $RUN/sessions.log
