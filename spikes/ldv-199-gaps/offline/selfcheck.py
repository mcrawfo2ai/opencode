#!/usr/bin/env python3
"""LDV-199 gaps: offline mutation self-check of verify.py (the independent comparator/ordering checker).

For each mutation: baseline green -> mutate a COPY -> must be red with the specific expected reason -> restore from the
original bytes (sha256 must be byte-identical) -> green again. Mutations: changed byte, changed offset, omitted ack,
early exit release, detach before owner close, wrong identity, null-to-zero. The null test is SYNTHETIC: it only
exercises the instrument's preservation rule and says nothing about native null production.
usage: selfcheck.py --evidence DIR --work WORKDIR [--report FILE]
"""
import argparse
import hashlib
import json
import os
import shutil
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify  # noqa: E402


def sha(b):
    return hashlib.sha256(b).hexdigest()


def rb(p):
    with open(p, "rb") as f:
        return f.read()


def wb(p, b):
    with open(p, "wb") as f:
        f.write(b)


def red_of(report, case):
    r = next(c for c in report["cases"] if c["case"] == case)
    return r, [c for c in r["checks"] if c["status"] == "red"]


def run_case(root, case):
    return verify.verify_all(root, [case])


def trace_lines(p):
    return [json.loads(x) for x in rb(p).decode().splitlines() if x.strip()]


def write_trace(p, events):
    wb(p, ("\n".join(json.dumps(e, separators=(",", ":")) for e in events) + "\n").encode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--report")
    a = ap.parse_args()
    shutil.rmtree(a.work, ignore_errors=True)
    os.makedirs(a.work)
    wr = os.path.join(a.work, "ev")
    os.makedirs(os.path.join(wr, "cases"))
    for c in ("B1", "A", "B-daemon"):
        shutil.copytree(os.path.join(a.evidence, "cases", c), os.path.join(wr, "cases", c))
    shutil.copy(os.path.join(a.evidence, "trace.jsonl"), os.path.join(wr, "trace.jsonl"))
    out = []

    def attempt(name, mutation, case, files, mutate, expect):
        """files: list of paths (relative to wr) that mutate() may change; expect(red_checks)->(bool, reason)"""
        orig = {f: rb(os.path.join(wr, f)) for f in files}
        base = run_case(wr, case)
        base_red = [c["name"] for c in red_of(base, case)[1]]
        info = mutate()
        mut = run_case(wr, case)
        _, reds = red_of(mut, case)
        ok, reason = expect(reds, info)
        for f, b in orig.items():
            wb(os.path.join(wr, f), b)
        restored_identical = all(sha(rb(os.path.join(wr, f))) == sha(b) for f, b in orig.items())
        after = run_case(wr, case)
        after_red = [c["name"] for c in red_of(after, case)[1]]
        out.append({"name": name, "mutation": mutation, "case": case, "files": files, "mutation_info": info, "baseline_green": not base_red, "red_after_mutation": [c["name"] for c in reds], "red_detail": [{k: v for k, v in c.items() if k != "status"} for c in reds][:3], "expected_reason_met": ok, "expected_reason": reason, "restored_byte_identical": restored_identical, "green_after_restore": not after_red, "pass": (not base_red) and bool(reds) and ok and restored_identical and not after_red})

    # ---- 1 changed byte (W capture of B1): flip one payload byte in the first output frame
    rxrel = "cases/B1/captures/W.rx.bin"

    def m_byte():
        buf = bytearray(rb(os.path.join(wr, rxrel)))
        an = verify.analyze_rx(bytes(buf))
        fr = next(f for f in an["frames"] if f["kind"] == "output" and f["data_len"] >= 3)
        pos = fr["data_off"] + 2
        orig = buf[pos]
        buf[pos] = orig ^ 0xFF
        wb(os.path.join(wr, rxrel), bytes(buf))
        return {"native_offset": fr["start"] + 2, "orig_byte": orig, "new_byte": orig ^ 0xFF}

    attempt("changed-byte", "XOR 0xFF on payload byte 2 of the first output frame in B1/W.rx.bin", "B1", [rxrel], m_byte,
            lambda reds, i: (any(c["name"] == "bytes-vs-oracle:W" and c.get("first_difference") and c["first_difference"]["native_offset"] == i["native_offset"] and c["first_difference"]["native_byte"] == i["new_byte"] and c["first_difference"]["oracle_byte"] == i["orig_byte"] for c in reds), "bytes-vs-oracle:W first_difference at native offset %d" % 0))

    # ---- 2 changed offset: shift the first output frame's start/end header fields by +1 (data and oracle unchanged)
    def m_off():
        buf = bytearray(rb(os.path.join(wr, rxrel)))
        an = verify.analyze_rx(bytes(buf))
        fr = next(f for f in an["frames"] if f["kind"] == "output")
        h = fr["off"] + 4 + 1
        s, e = struct.unpack(">QQ", bytes(buf[h:h + 16]))
        buf[h:h + 16] = struct.pack(">QQ", s + 1, e + 1)
        wb(os.path.join(wr, rxrel), bytes(buf))
        return {"start_before": s, "end_before": e, "start_after": s + 1, "end_after": e + 1}

    attempt("changed-offset", "start/end uint64 of the first output frame +1 in B1/W.rx.bin", "B1", [rxrel], m_off,
            lambda reds, i: (any(c["name"] == "bytes-vs-oracle:W" and ((c.get("first_difference") or {}).get("native_offset") == i["start_after"] or c.get("beyond_oracle_bytes")) for c in reds), "bytes-vs-oracle:W difference at shifted start or bytes beyond oracle"))

    # ---- 3 omitted ack (B1 trace): remove the intermediate ack observation
    tr = "trace.jsonl"

    def m_noack():
        ev = trace_lines(os.path.join(wr, tr))
        keep = [e for e in ev if not (e["case"] == "B1" and e["kind"] == "ack-observed" and e.get("stage") == "mid-emitted")]
        write_trace(os.path.join(wr, tr), keep)
        return {"removed_events": len(ev) - len(keep)}

    attempt("omitted-ack", "removed B1 ack-observed(mid-emitted) from trace.jsonl", "B1", [tr], m_noack,
            lambda reds, i: (any(c["name"] == "ordering:exit-gates" and any("without a prior intermediate acknowledgment" in v["reason"] for v in c.get("violations", [])) for c in reds), "ordering: exit gate released without a prior intermediate acknowledgment"))

    # ---- 4 early exit (B1 trace): exit gate release sequenced before native-running
    def m_early():
        ev = trace_lines(os.path.join(wr, tr))
        i_run = next(i for i, e in enumerate(ev) if e["case"] == "B1" and e["kind"] == "native-running")
        i_rel = next(i for i, e in enumerate(ev) if e["case"] == "B1" and e["kind"] == "gate-release" and e.get("gate") == "exit")
        ev[i_run]["seq"], ev[i_rel]["seq"] = ev[i_rel]["seq"], ev[i_run]["seq"]
        ev[i_run], ev[i_rel] = ev[i_rel], ev[i_run]
        write_trace(os.path.join(wr, tr), ev)
        return {"swapped_indices": [i_run, i_rel]}

    attempt("early-exit-release", "swapped B1 native-running and gate-release(exit) in trace.jsonl", "B1", [tr], m_early,
            lambda reds, i: (any(c["name"] == "ordering:exit-gates" and any("without a native-running observation" in v["reason"] for v in c.get("violations", [])) for c in reds), "ordering: exit gate released without a native-running observation after the ack"))

    # ---- 5 detach before owner close (case A trace)
    def m_detach():
        ev = trace_lines(os.path.join(wr, tr))
        i_oc = next(i for i, e in enumerate(ev) if e["case"] == "A" and e["kind"] == "owner-close-action")
        oc_seq = ev[i_oc]["seq"]
        # case A's real subscriber sockets were closed by the daemon, so the real trace has no cleanup detach to move:
        # INSERT a detach event sequenced before the owner-close action (a detach-first cleanup)
        det = {"seq": oc_seq - 0.5, "t_ms": ev[i_oc]["t_ms"], "wall_ms": ev[i_oc]["wall_ms"], "case": "A", "kind": "sub-detach", "sub": "M", "reason": "MUTATION: detach before owner close"}
        ev.insert(i_oc, det)
        write_trace(os.path.join(wr, tr), ev)
        return {"inserted_detach_seq": det["seq"], "owner_close_seq": oc_seq}

    attempt("detach-before-owner-close", "inserted a sub-detach event sequenced before A owner-close-action", "A", [tr], m_detach,
            lambda reds, i: (any(c["name"] == "ordering:case-A-owner-close" and any("detach before owner-close" in v["reason"] or "BEFORE owner-close-action" in v["reason"] for v in c.get("violations", [])) for c in reds), "case A: detach sequenced before owner-close"))

    # ---- 6 wrong identity (B1 meta): substitute PTY id, then instance id
    mrel = "cases/B1/captures/M.meta.json"

    def m_id():
        m = json.loads(rb(os.path.join(wr, mrel)))
        m["expected_identity"]["pty_id"] += 1
        wb(os.path.join(wr, mrel), json.dumps(m, indent=1).encode())
        return {"pty_id_changed_by": 1}

    attempt("wrong-identity-pty", "expected_identity.pty_id +1 in B1/M.meta.json", "B1", [mrel], m_id,
            lambda reds, i: (any(c["name"] == "identity:M" and any("expected pty_id" in v for v in c.get("violations", [])) for c in reds), "identity:M meta expected pty_id != raw created id"))

    def m_inst():
        m = json.loads(rb(os.path.join(wr, mrel)))
        m["expected_identity"]["instance_id"] = "0" * 32
        wb(os.path.join(wr, mrel), json.dumps(m, indent=1).encode())
        return {"instance_id_substituted": "0"*32}

    attempt("wrong-identity-instance", "expected_identity.instance_id substituted in B1/M.meta.json", "B1", [mrel], m_inst,
            lambda reds, i: (any(c["name"] == "identity:M" and any("expected instance_id" in v for v in c.get("violations", [])) for c in reds), "identity:M meta expected instance != raw pong instance"))

    # ---- 7 null-to-zero (SYNTHETIC stream: tests the instrument's preservation rule only)
    def frame(b):
        return struct.pack(">I", len(b)) + b

    def synth(code_text):
        att = json.dumps({"type": "attached", "terminal": {"id": 1}, "role": "observer", "generation": 0, "requested_offset": 0, "available_offset": 0, "end_offset": 0, "truncated": False, "replay_base64": ""}, separators=(",", ":")).encode()
        ex = ('{"type":"exited","exit_code":%s,"final_offset":0}' % code_text).encode()
        buf = frame(att) + frame(ex)
        an = verify.analyze_rx(buf)
        _, _, exits, _ = verify.socket_intervals(buf, an)
        return exits

    rec = {"name": "null-to-zero (synthetic)", "case": "synthetic", "note": "SYNTHETIC null: exercises only the instrument's preservation rule; it is not evidence of native null production"}
    exits_null = synth("null")
    view_ok = {"exit_code_raw": None, "exit_code_key_present": True}
    base = verify.check_exit_codes(exits_null, view_ok)
    mut_view = dict(view_ok, exit_code_raw=0)
    red1 = verify.check_exit_codes(exits_null, mut_view)
    exits_zero = synth("0")
    red2 = verify.check_exit_codes(exits_zero, view_ok)  # wire text mutated null->0 while the recorded view stays null
    restored = verify.check_exit_codes(synth("null"), dict(view_ok))
    rec.update({"baseline_green": base["status"] == "green", "red_after_mutation": [n for n, r in (("recorded null->0", red1), ("wire null->0", red2)) if r["status"] == "red"], "red_detail": [red1["detail"], red2["detail"]], "expected_reason_met": "!= raw wire None" in red1["detail"] and "!= raw wire 0" in red2["detail"], "restored_byte_identical": True, "green_after_restore": restored["status"] == "green"})
    rec["pass"] = rec["baseline_green"] and len(rec["red_after_mutation"]) == 2 and rec["expected_reason_met"] and rec["green_after_restore"]
    out.append(rec)

    rep = {"evidence": os.path.abspath(a.evidence), "mutations": out, "all_pass": all(m["pass"] for m in out)}
    if a.report:
        with open(a.report, "w") as f:
            json.dump(rep, f, indent=1)
    for m in out:
        print("%-5s %-28s red=%s restored_identical=%s green_after=%s" % ("PASS" if m["pass"] else "FAIL", m["name"], m["red_after_mutation"], m["restored_byte_identical"], m["green_after_restore"]))
    print("ALL PASS" if rep["all_pass"] else "SOME FAIL")
    return 0 if rep["all_pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
