#!/bin/bash
# killrun.sh RUNDIR: kill every process whose environment has RUN=RUNDIR (drivers, samplers, curl SSE), then the server.
for p in /proc/[0-9]*; do
  { tr "\0" "\n" < $p/environ; } 2>/dev/null | grep -qx "RUN=$1" && [ "${p#/proc/}" != "$$" ] && kill ${p#/proc/} 2>/dev/null
done
[ -f $1/pid ] && kill $(cat $1/pid) 2>/dev/null
true
