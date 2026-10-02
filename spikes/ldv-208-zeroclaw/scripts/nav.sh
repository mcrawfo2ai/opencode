#!/usr/bin/env bash
# Throwaway: run a navigation command, echo its output, append measured bytes to the read ledger.
# usage: nav.sh <label> <command...>
label="$1"; shift
out=$(bash -c "$*" 2>&1); n=$(printf '%s' "$out" | wc -c)
printf '%s\n' "$out"
printf '%s\t%s\t%s\n' "$(date -u +%T)" "$n" "$label :: $*" | cut -c1-300 >> /home/user/opencode/spikes/ldv-208-zeroclaw/evidence/read-ledger.tsv
