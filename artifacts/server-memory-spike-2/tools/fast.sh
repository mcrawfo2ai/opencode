#!/bin/bash
# fast.sh PID OUT: 1 s sampler of VmRSS, VmHWM, anon (KiB)
while kill -0 $1 2>/dev/null; do
  echo "$(date +%s.%N | cut -c1-14) $(awk '/^VmRSS/{r=$2}/^VmHWM/{h=$2}END{print r, h}' /proc/$1/status) $(awk '/^Anonymous/{print $2}' /proc/$1/smaps_rollup)" >> $2
  sleep 1
done
