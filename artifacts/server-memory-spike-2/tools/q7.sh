#!/bin/bash
# q7.sh: RUN PORT OCBIN SCRIPT [MODEL]; all features, 3 dirs with big files; 1 s sampler alongside drive4.
T=$(dirname $(readlink -f $0))
export F_OPENCODE=1 F_LSP=1 F_PLUGINS=1 F_PROVIDERS=1 F_BIG=1 MAXN=3 CHECKS="1 2 3" IDLE=${IDLE:-120}
$T/drive4.sh &
D=$!
for i in $(seq 1 120); do [ -s $RUN/pid ] && kill -0 $(cat $RUN/pid) 2>/dev/null && break; sleep 1; done
$T/fast.sh $(cat $RUN/pid) $RUN/fast.txt &
wait $D
