#!/bin/bash
# snap.sh PID LABEL -> one JSON line of /proc metrics
pid=$1; label=$2
r=/proc/$pid
rss=$(awk '/^VmRSS/{print $2}' $r/status); hwm=$(awk '/^VmHWM/{print $2}' $r/status)
thr=$(awk '/^Threads/{print $2}' $r/status)
anon=$(awk '/^Anonymous/{print $2}' $r/smaps_rollup); pd=$(awk '/^Private_Dirty/{print $2}' $r/smaps_rollup)
declare -A c; for k in ptmx pts inotify eventpoll socket eventfd pipe file other; do c[$k]=0; done
for f in $r/fd/*; do t=$(readlink $f 2>/dev/null); case "$t" in
 /dev/ptmx) c[ptmx]=$((c[ptmx]+1));; /dev/pts/*) c[pts]=$((c[pts]+1));;
 *inotify*) c[inotify]=$((c[inotify]+1));; *eventpoll*) c[eventpoll]=$((c[eventpoll]+1));;
 socket:*) c[socket]=$((c[socket]+1));; *eventfd*) c[eventfd]=$((c[eventfd]+1));; pipe:*) c[pipe]=$((c[pipe]+1));;
 /*) c[file]=$((c[file]+1));; *) c[other]=$((c[other]+1));; esac; done
kids=$(pgrep -P $pid | wc -l); desc=$(ps --ppid $pid -o rss= | awk '{s+=$1}END{print s+0}')
iw=$(cat $r/fdinfo/* 2>/dev/null | grep -c '^inotify wd')
printf '{"t":"%s","label":"%s","rss_kb":%s,"hwm_kb":%s,"anon_kb":%s,"privdirty_kb":%s,"threads":%s,"ptmx":%s,"pts":%s,"inotify":%s,"inotify_watches":%s,"eventpoll":%s,"socket":%s,"eventfd":%s,"pipe":%s,"file":%s,"children":%s,"children_rss_kb":%s}\n' \
 "$(date +%T)" "$label" $rss $hwm $anon $pd $thr ${c[ptmx]} ${c[pts]} ${c[inotify]} $iw ${c[eventpoll]} ${c[socket]} ${c[eventfd]} ${c[pipe]} ${c[file]} $kids $desc
