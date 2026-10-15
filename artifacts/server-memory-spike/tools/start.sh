#!/bin/bash
source $(dirname $0)/env.sh
cd $RUN
nohup env -u BUN_OPTIONS -u BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE "$@" $OCBIN serve --hostname 127.0.0.1 --port ${PORT:-4096} --print-logs --log-level INFO > $RUN/server.log 2>&1 < /dev/null &
echo $! > $RUN/pid
sleep 6; cat $RUN/pid
