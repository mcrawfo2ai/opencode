#!/usr/bin/env python3
"""LDV-199 gaps: independent offline reader/verifier. Python standard library only.

It imports NOTHING from the cloud client or its comparator. It re-derives everything from:
  captures/<socket>.rx.bin     raw bytes received on one socket (uint32BE length + payload frames, lossless)
  captures/<socket>.replay.bin decoded attached-replay bytes (cross-checked against the base64 inside rx.bin)
  fx-<name>/oracle.frozen.bin  immutable tee oracle;  oracle.boundaries.json  prefix hashes
  samples/*.jsonl, requests/*.rx.bin  raw native list/create/pong payloads
  trace.jsonl                  ordered monotonic action trace;  fx-<name>/acks/*.json fixture-side acks

Subcommands:
  all        verify every case that has a case.json (default)
  case       verify the named cases
  interval   reconstruct native [a,b) from one socket's frames/replay and compare to oracle [a-O,b-O)
Exit status 0 only if no check is red. "facts" (e.g. truncation, EOF, adverse outcomes) are reported, never hidden.
"""
import argparse
import base64
import hashlib
import json
import os
import struct
import sys

MAX_FRAME = 8388608
SAFE = 2 ** 53 - 1


def sha(b):
    return hashlib.sha256(b).hexdigest()


def rj(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def rjl(path):
    out = []
    with open(path, "rb") as f:
        for line in f.read().decode("utf-8").splitlines():
            if line.strip():
                out.append(json.loads(line))
    return out


def rb(path):
    with open(path, "rb") as f:
        return f.read()


# ------------------------------------------------------------------ frame parsing (independent)
def parse_frames(buf):
    frames, problems, pos, n = [], [], 0, len(buf)
    while pos < n:
        if n - pos < 4:
            problems.append({"kind": "incomplete-header", "offset": pos, "have": n - pos, "hex": buf[pos:].hex()})
            break
        length = int.from_bytes(buf[pos:pos + 4], "big")
        if length > MAX_FRAME:
            problems.append({"kind": "frame-limit", "offset": pos, "declared": length, "bytes_after_header": n - pos - 4})
            break
        if n - pos - 4 < length:
            problems.append({"kind": "incomplete-frame", "offset": pos, "declared": length, "have": n - pos - 4})
            break
        frames.append({"off": pos, "len": length})
        pos += 4 + length
    return frames, problems, pos


def classify(buf, fr):
    p = buf[fr["off"] + 4: fr["off"] + 4 + fr["len"]]
    if len(p) > 0 and p[0] == 0:
        if len(p) < 17:
            return {"kind": "output-invalid", "problems": ["short output frame"], **fr}
        s, e = struct.unpack(">QQ", p[1:17])
        probs = []
        if s > SAFE or e > SAFE:
            probs.append("offset beyond safe integer")
        if e < s:
            probs.append("end < start")
        if not probs and e - s != len(p) - 17:
            probs.append("end-start=%d != payload length %d" % (e - s, len(p) - 17))
        return {"kind": "output", "start": s, "end": e, "data_off": fr["off"] + 4 + 17, "data_len": len(p) - 17, "problems": probs, **fr}
    try:
        text = p.decode("utf-8")
        j = json.loads(text)
        return {"kind": "json", "type": j.get("type") if isinstance(j, dict) else None, "json": j, "text": text, "problems": [], **fr}
    except Exception as ex:  # noqa: BLE001
        return {"kind": "json-invalid", "problems": [str(ex)], **fr}


def analyze_rx(buf):
    frames, stream_problems, consumed = parse_frames(buf)
    classified = [classify(buf, f) for f in frames]
    return {"frames": classified, "stream_problems": stream_problems, "consumed": consumed, "total_bytes": len(buf), "incomplete_tail_bytes": len(buf) - consumed}


def replay_interval(att, replay):
    """Derived rule (NOT on the wire): replay starts at requested_offset if length == end-requested and
    requested >= available, else at available_offset if length == end-available, else unknown."""
    n = len(replay)
    if n == att["end_offset"] - att["requested_offset"] and att["requested_offset"] >= att["available_offset"]:
        return att["requested_offset"], "requested_offset"
    if n == att["end_offset"] - att["available_offset"]:
        return att["available_offset"], "available_offset"
    return None, "unverified"


def socket_intervals(buf, an):
    """Return (intervals in arrival order, attached info, exited frames, problems)."""
    ivs, attached, exits, problems = [], None, [], []
    for i, fr in enumerate(an["frames"]):
        if fr["kind"] == "output":
            if fr["problems"]:
                problems.append({"frame": i, "problems": fr["problems"]})
                continue
            ivs.append({"src": "frame", "frame": i, "start": fr["start"], "end": fr["end"], "data": buf[fr["data_off"]: fr["data_off"] + fr["data_len"]]})
        elif fr["kind"] == "json":
            j = fr["json"]
            if fr["type"] == "attached" and attached is None:
                try:
                    replay = base64.b64decode(j["replay_base64"], validate=True)
                except Exception as ex:  # noqa: BLE001
                    problems.append({"frame": i, "problems": ["replay base64 invalid: %s" % ex]})
                    replay = b""
                start, basis = replay_interval(j, replay)
                attached = {"frame": i, "role": j.get("role"), "generation": j.get("generation"), "requested_offset": j["requested_offset"], "available_offset": j["available_offset"], "end_offset": j["end_offset"], "truncated": j["truncated"], "replay_len": len(replay), "replay_start": start, "replay_basis": basis, "replay": replay, "terminal": j.get("terminal")}
                if len(replay) > 0 and start is not None:
                    ivs.insert(0, {"src": "replay", "frame": i, "start": start, "end": start + len(replay), "data": replay})
            elif fr["type"] == "exited":
                exits.append({"frame": i, "raw_payload": fr["text"], "key_present": "exit_code" in j, "exit_code": j.get("exit_code"), "final_offset": j.get("final_offset")})
        elif fr["kind"] in ("output-invalid", "json-invalid"):
            problems.append({"frame": i, "problems": fr["problems"]})
    return ivs, attached, exits, problems


# ------------------------------------------------------------------ comparison (exact bytes)
def compare_to_oracle(ivs, oracle, origin):
    res = {"intervals": len(ivs), "compared_bytes": 0, "pre_origin_bytes": 0, "beyond_oracle_bytes": 0, "first_difference": None}
    hn, ho = hashlib.sha256(), hashlib.sha256()
    for iv in ivs:
        a, b, data = iv["start"], iv["end"], iv["data"]
        if len(data) != b - a:
            res.setdefault("bounds_problems", []).append({"src": iv["src"], "frame": iv["frame"], "start": a, "end": b, "data_len": len(data)})
            continue
        skip = 0
        if a < origin:
            skip = min(origin - a, len(data))
            res["pre_origin_bytes"] += skip
        seg = data[skip:]
        lo = a + skip - origin
        if lo + len(seg) > len(oracle):
            extra = lo + len(seg) - len(oracle)
            res["beyond_oracle_bytes"] += min(extra, len(seg))
            seg = seg[: max(0, len(oracle) - lo)]
        exp = oracle[lo: lo + len(seg)]
        hn.update(seg)
        ho.update(exp)
        res["compared_bytes"] += len(seg)
        if res["first_difference"] is None and seg != exp:
            k = next(i for i in range(len(seg)) if seg[i] != exp[i])
            res["first_difference"] = {"native_offset": a + skip + k, "oracle_index": lo + k, "native_byte": seg[k], "oracle_byte": exp[k], "src": iv["src"], "frame": iv["frame"], "interval": [a, b]}
    res["native_sha256"], res["oracle_sha256"] = hn.hexdigest(), ho.hexdigest()
    res["ok"] = res["first_difference"] is None and not res.get("bounds_problems") and res["beyond_oracle_bytes"] == 0
    return res


def coverage(ivs):
    if not ivs:
        return {"intervals": 0, "holes": [], "overlaps": []}
    srt = sorted(((i["start"], i["end"]) for i in ivs))
    holes, overlaps, pos = [], [], srt[0][0]
    lo = pos
    for s, e in srt:
        if s > pos:
            holes.append([pos, s])
        if s < pos:
            overlaps.append([s, min(pos, e)])
        pos = max(pos, e)
    return {"from": lo, "to": pos, "intervals": len(srt), "holes": holes, "overlaps": overlaps}


# ------------------------------------------------------------------ evidence access
class Ev:
    def __init__(self, root):
        self.root = root
        self.trace = rjl(os.path.join(root, "trace.jsonl")) if os.path.exists(os.path.join(root, "trace.jsonl")) else []

    def p(self, *rel):
        return os.path.join(self.root, *rel)

    def case_dir(self, case):
        return self.p("cases", case)

    def load_case(self, case):
        return rj(os.path.join(self.case_dir(case), "case.json"))

    def case_trace(self, case):
        return [e for e in self.trace if e.get("case") == case]


def read_origin(ev, case, fxd):
    """O from the raw native list payload captured while start was held: head must equal tail."""
    f = os.path.join(ev.case_dir(case), fxd["origin_sample_file"])
    rows = rjl(f)
    for r in reversed(rows):
        if not r.get("raw_payload"):
            continue
        j = json.loads(r["raw_payload"])
        for t in j.get("terminals", []):
            if t["id"] == fxd["pty_id"]:
                return {"head": t["output_head"], "tail": t["output_tail"], "origin": t["output_tail"], "head_equals_tail": t["output_head"] == t["output_tail"], "sample_seq": r["seq"]}
    return None


def created_terminal(ev, fxd):
    an = analyze_rx(rb(ev.p(fxd["create_rx"])))
    for fr in an["frames"]:
        if fr["kind"] == "json" and fr["type"] == "created":
            return fr["json"]["terminal"]
    return None


def pong(ev, daemon_rec):
    if not daemon_rec.get("ping_rx"):
        return None
    an = analyze_rx(rb(ev.p(daemon_rec["ping_rx"])))
    for fr in an["frames"]:
        if fr["kind"] == "json" and fr["type"] == "pong":
            return fr["json"]
    return None


# ------------------------------------------------------------------ individual checks (callable by selfcheck)
def check_exit_codes(exits, meta_view):
    """Client-recorded exited view must preserve the raw wire value exactly (null stays null, absent stays absent)."""
    if not exits:
        return {"status": "green", "detail": "no exited frame on this socket"}
    if meta_view is None:
        return {"status": "red", "detail": "exited frame on wire but client recorded none"}
    e = exits[0]
    if e["key_present"] != meta_view.get("exit_code_key_present") or e["exit_code"] != meta_view.get("exit_code_raw") or type(e["exit_code"]) is not type(meta_view.get("exit_code_raw")):
        return {"status": "red", "detail": "recorded exit_code %r (key_present=%r) != raw wire %r (key_present=%r)" % (meta_view.get("exit_code_raw"), meta_view.get("exit_code_key_present"), e["exit_code"], e["key_present"])}
    return {"status": "green", "detail": "raw exit_code %r preserved (key present=%r)" % (e["exit_code"], e["key_present"])}


INTERMEDIATE = ("mid-emitted",)


def check_ordering(events, fx_ack_dir_lookup=None):
    """Per fixture: an exit-class gate release requires (intermediate ack) < (native-running) < release, in trace order."""
    viol, checked = [], 0
    by = {}
    for e in events:
        fx = e.get("fx")
        if fx is None:
            continue
        st = by.setdefault(fx, {"ack": [], "running": []})
        if e["kind"] == "ack-observed" and (e.get("stage") in INTERMEDIATE or str(e.get("stage", "")).startswith("chunk")):
            st["ack"].append(e["seq"])
        elif e["kind"] == "native-running" and (e.get("terminal") or {}).get("lifecycle", {}).get("status") == "running":
            st["running"].append(e["seq"])
        elif e["kind"] == "gate-release" and e.get("gate") in ("exit", "outer") and not e.get("cleanup"):
            checked += 1
            acks_before = [s for s in st["ack"] if s < e["seq"]]
            runs_after_ack = [s for s in st["running"] if s < e["seq"] and acks_before and s > min(acks_before)]
            if not acks_before:
                viol.append({"fx": fx, "release_seq": e["seq"], "reason": "exit gate released without a prior intermediate acknowledgment"})
            elif not runs_after_ack:
                viol.append({"fx": fx, "release_seq": e["seq"], "reason": "exit gate released without a native-running observation after the intermediate ack"})
    return {"status": "red" if viol else "green", "checked_exit_releases": checked, "violations": viol}


def check_case_a(events):
    """Owner-close must be sequenced before any resulting EOF, daemon death or cleanup detach; pre-close MID prerequisites first."""
    viol = []
    oc = [e for e in events if e["kind"] == "owner-close-action"]
    if not oc:
        return {"status": "red", "violations": [{"reason": "owner-close-action not recorded"}]}
    seq = oc[0]["seq"]
    for e in events:
        if e["seq"] < seq:
            continue
        if e["kind"] in ("sub-detach",) and e["seq"] < seq:
            viol.append({"seq": e["seq"], "reason": "detach before owner-close"})
    before = [e for e in events if e["seq"] < seq]
    for e in events:
        if e["kind"] in ("sub-detach", "daemon-exit-event") or (e["kind"] == "sub-conn" and e.get("conn_event") in ("eof", "close")) or (e["kind"] == "owner-item" and e.get("conn_event") in ("eof", "close")):
            if e["seq"] < seq:
                viol.append({"seq": e["seq"], "kind": e["kind"], "reason": "%s sequenced BEFORE owner-close-action" % e["kind"]})
    # property-observation end must precede the first cleanup detach
    pe = [e for e in events if e["kind"] == "property-observation-end"]
    dets = [e for e in events if e["kind"] == "sub-detach"]
    if not pe:
        viol.append({"reason": "property-observation-end not recorded"})
    elif dets and min(d["seq"] for d in dets) < pe[0]["seq"]:
        viol.append({"reason": "sub-detach before property observation finished/timed out"})
    if not [e for e in before if e["kind"] == "ack-observed" and e.get("stage") == "mid-emitted"]:
        viol.append({"reason": "no MID ack before owner-close"})
    if not [e for e in before if e["kind"] == "native-running"]:
        viol.append({"reason": "no native-running observation before owner-close"})
    if not [e for e in before if e["kind"] == "delivery" and e.get("stage") == "mid-emitted" and e.get("ok")]:
        viol.append({"reason": "no confirmed M/W delivery of MID before owner-close"})
    return {"status": "red" if viol else "green", "owner_close_seq": seq, "violations": viol}


def check_identity(ev, case, cj, meta, attached, socket_label):
    fxd = next((f for f in cj["fixtures"] if f["name"] == meta["fx"]), None)
    viol = []
    if not fxd:
        return {"status": "red", "detail": "fixture %s not in case.json" % meta["fx"]}
    ct = created_terminal(ev, fxd)
    if not ct:
        return {"status": "red", "detail": "created terminal not recoverable from raw create response"}
    exp = meta.get("expected_identity", {})
    if exp.get("pty_id") != ct["id"]:
        viol.append("meta expected pty_id %r != raw created id %r" % (exp.get("pty_id"), ct["id"]))
    if exp.get("group_id") != ct["group_id"]:
        viol.append("meta expected group_id %r != raw created group %r" % (exp.get("group_id"), ct["group_id"]))
    d = next((x for x in cj["daemons"] if x["tag"] == meta.get("daemon")), None)
    pg = pong(ev, d) if d else None
    if pg is None:
        viol.append("daemon pong not recoverable for instance check")
    elif exp.get("instance_id") != pg["instance_id"]:
        viol.append("meta expected instance_id %r != raw pong instance %r" % (exp.get("instance_id"), pg["instance_id"]))
    if attached:
        t = attached["terminal"] or {}
        if t.get("id") != ct["id"]:
            viol.append("attached terminal id %r != created id %r" % (t.get("id"), ct["id"]))
        if t.get("group_id") != ct["group_id"]:
            viol.append("attached terminal group %r != created group %r" % (t.get("group_id"), ct["group_id"]))
    return {"status": "red" if viol else "green", "violations": viol, "socket": socket_label}


# ------------------------------------------------------------------ per-case verification
def verify_case(ev, case):
    cj = ev.load_case(case)
    cdir = ev.case_dir(case)
    checks, facts = [], {"case": case, "sockets": {}, "fixtures": {}}

    def add(name, st=None, **kw):
        rec = {"name": name, **kw}
        if st is not None:
            rec["status"] = st
        checks.append(rec)

    for fxd in cj["fixtures"]:
        fdir = os.path.join(cdir, fxd["dir_rel"])
        oracle = rb(os.path.join(fdir, "oracle.frozen.bin"))
        og = read_origin(ev, case, fxd)
        facts["fixtures"][fxd["name"]] = {"oracle_bytes": len(oracle), "oracle_sha256": sha(oracle), "origin": og, "pid": fxd["pid"]}
        add("origin:%s" % fxd["name"], "green" if og and og["head_equals_tail"] else "red", detail=og)
        # boundaries: every recorded boundary must be a prefix of the final frozen oracle
        bnd = rj(os.path.join(fdir, "oracle.boundaries.json"))
        bad = [b for b in bnd if b["length"] > len(oracle) or sha(oracle[: b["length"]]) != b["sha256"]]
        add("oracle-boundaries-prefix:%s" % fxd["name"], "red" if bad else "green", boundaries=len(bnd), violations=bad)
        # terminal mode + fixture-side facts
        try:
            after = open(os.path.join(fdir, "mode.after.txt")).read().split()
            size = open(os.path.join(fdir, "mode.size.txt")).read().strip()
            ok = "-echo" in after and "-opost" in after and size == "24 80"
            add("mode:%s" % fxd["name"], "green" if ok else "red", echo_off="-echo" in after, opost_off="-opost" in after, size=size)
        except Exception as ex:  # noqa: BLE001
            add("mode:%s" % fxd["name"], "red", detail=str(ex))
    seen_o = {f["name"]: facts["fixtures"][f["name"]]["origin"] for f in cj["fixtures"]}
    for s in cj["sockets"]:
        meta = rj(os.path.join(cdir, s["meta"]))
        rxpath = os.path.join(cdir, s["rx"])
        buf = rb(rxpath)
        an = analyze_rx(buf)
        ivs, attached, exits, probs = socket_intervals(buf, an)
        fxd = next(f for f in cj["fixtures"] if f["name"] == meta["fx"])
        fdir = os.path.join(cdir, fxd["dir_rel"])
        oracle = rb(os.path.join(fdir, "oracle.frozen.bin"))
        o = (seen_o.get(meta["fx"]) or {}).get("origin")
        lab = s["label"]
        sf = {"rx_bytes": len(buf), "rx_sha256": sha(buf), "frames": len(an["frames"]), "stream_problems": an["stream_problems"], "output_frames": sum(1 for f in an["frames"] if f["kind"] == "output"), "frame_problems": probs, "attached": None if not attached else {k: v for k, v in attached.items() if k not in ("replay", "terminal")}, "exits": exits, "coverage": coverage(ivs), "client_view": {"eof": meta.get("eof"), "close": meta.get("close")}}
        # 1 well-formedness
        add("frames-wellformed:%s" % lab, "red" if probs else "green", frame_problems=probs, stream_problems=an["stream_problems"], note="incomplete/limit stream problems are facts; invalid output frames are red")
        # 2 replay file equals base64 inside rx.bin
        rf = (meta.get("attach") or {}).get("replay_file")
        if rf and rf.get("path"):
            rbytes = rb(ev.p(rf["path"]))
            same = attached is not None and rbytes == attached["replay"] and sha(rbytes) == rf["sha256"]
            add("replay-file-matches-wire:%s" % lab, "green" if same else "red", replay_sha256=sha(rbytes))
        # 3 client index cross-check (instrument cross-check)
        if os.path.exists(os.path.join(cdir, s["index"])):
            idx = [r for r in rjl(os.path.join(cdir, s["index"])) if not str(r.get("kind", "")).startswith("conn:")]
            mine = [(f["off"], f["len"]) for f in an["frames"]]
            theirs = [(r["hdrOff"], r["payload_len"]) for r in idx if "hdrOff" in r and r.get("kind") != "frame-limit"]
            add("client-index-crosscheck:%s" % lab, "green" if mine == theirs else "red", frames_independent=len(mine), frames_client=len(theirs))
        # 4 bytes vs oracle
        if o is None:
            add("bytes-vs-oracle:%s" % lab, "red", detail="origin not established")
        elif ivs:
            cmp = compare_to_oracle(ivs, oracle, o)
            sf["compare"] = {k: v for k, v in cmp.items()}
            add("bytes-vs-oracle:%s" % lab, "green" if cmp["ok"] else "red", compared_bytes=cmp["compared_bytes"], first_difference=cmp["first_difference"], beyond_oracle_bytes=cmp["beyond_oracle_bytes"], pre_origin_bytes=cmp["pre_origin_bytes"], native_sha256=cmp["native_sha256"], oracle_sha256=cmp["oracle_sha256"])
        else:
            add("bytes-vs-oracle:%s" % lab, "green", compared_bytes=0, detail="no native bytes on this socket")
        # 5 identity binding
        add("identity:%s" % lab, **{k: v for k, v in check_identity(ev, case, cj, meta, attached, lab).items()})
        # 6 exit-code preservation
        add("exit-code-preservation:%s" % lab, **check_exit_codes(exits, meta.get("exited_frame_client_view")))
        facts["sockets"][lab] = sf
    # ordering checks from the monotonic trace
    events = ev.case_trace(case)
    add("ordering:exit-gates", **check_ordering(events))
    if case == "A":
        add("ordering:case-A-owner-close", **check_case_a(events))
    # fixture-side ack wall times vs driver gate releases (independent witness of gating order)
    for fxd in cj["fixtures"]:
        fdir = os.path.join(cdir, fxd["dir_rel"])
        gl = rj(os.path.join(fdir, "gate-log.json"))
        acks = {}
        ad = os.path.join(fdir, "acks")
        if os.path.isdir(ad):
            for n in os.listdir(ad):
                acks[n[:-5]] = rj(os.path.join(ad, n))
        ex = [g for g in gl if g["gate"] in ("exit", "outer") and not g.get("cleanup")]
        if ex and "mid-emitted" in acks:
            ok = acks["mid-emitted"]["wall_us"] // 1000 <= ex[0]["wall_ms"]
            add("ack-before-exit-release(file clocks):%s" % fxd["name"], "green" if ok else "red", mid_ack_wall_ms=acks["mid-emitted"]["wall_us"] // 1000, exit_release_wall_ms=ex[0]["wall_ms"])
    return {"case": case, "checks": checks, "facts": facts, "red": [c["name"] for c in checks if c["status"] == "red"]}


def verify_all(root, cases=None):
    ev = Ev(root)
    names = cases or sorted(d for d in os.listdir(ev.p("cases")) if os.path.exists(os.path.join(ev.p("cases"), d, "case.json")))
    reps = [verify_case(ev, c) for c in names]
    return {"evidence": os.path.abspath(root), "cases": reps, "red_total": sum(len(r["red"]) for r in reps), "checks_total": sum(len(r["checks"]) for r in reps)}


def interval_cmd(root, case, fx, sock, a, b):
    ev = Ev(root)
    cj = ev.load_case(case)
    fxd = next(f for f in cj["fixtures"] if f["name"] == fx)
    s = next(x for x in cj["sockets"] if x["label"] == sock)
    cdir = ev.case_dir(case)
    buf = rb(os.path.join(cdir, s["rx"]))
    an = analyze_rx(buf)
    ivs, attached, exits, probs = socket_intervals(buf, an)
    og = read_origin(ev, case, fxd)
    o = og["origin"]
    oracle = rb(os.path.join(cdir, fxd["dir_rel"], "oracle.frozen.bin"))
    out = {"case": case, "fixture": fx, "socket": sock, "a": a, "b": b, "origin": o, "oracle_bytes": len(oracle)}
    if not (o <= a <= b <= o + len(oracle)):
        out["error"] = "requires O <= a <= b <= O+B with O=%d B=%d" % (o, len(oracle))
        return out
    got = bytearray(b - a)
    have = bytearray(b - a)
    conflicts = []
    for iv in ivs:
        lo, hi = max(a, iv["start"]), min(b, iv["end"])
        for pos in range(lo, hi):
            byte = iv["data"][pos - iv["start"]]
            if have[pos - a]:
                if got[pos - a] != byte:
                    conflicts.append(pos)
            else:
                got[pos - a], have[pos - a] = byte, 1
    holes, start = [], None
    for i, h in enumerate(have):
        if not h and start is None:
            start = i
        if h and start is not None:
            holes.append([a + start, a + i])
            start = None
    if start is not None:
        holes.append([a + start, b])
    exp = oracle[a - o: b - o]
    native = bytes(got[i] for i in range(len(got)) if have[i])
    expc = bytes(exp[i] for i in range(len(exp)) if have[i])
    first = next((i for i in range(len(native)) if native[i] != expc[i]), None)
    out.update({"covered_bytes": len(native), "holes": holes, "overlap_conflicts": conflicts[:20], "native_sha256": sha(native), "oracle_sha256_same_range": sha(expc), "oracle_slice_sha256_full": sha(exp), "native_len": len(native), "oracle_len": len(exp), "first_difference_offset": None if first is None else a + first, "equal": first is None and not holes and not conflicts})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd")
    pa = sub.add_parser("all")
    pa.add_argument("--evidence", required=True)
    pa.add_argument("--report")
    pc = sub.add_parser("case")
    pc.add_argument("--evidence", required=True)
    pc.add_argument("--case", action="append", required=True)
    pc.add_argument("--report")
    pi = sub.add_parser("interval")
    pi.add_argument("--evidence", required=True)
    pi.add_argument("--case", required=True)
    pi.add_argument("--fx", required=True)
    pi.add_argument("--socket", required=True)
    pi.add_argument("--a", type=int, required=True)
    pi.add_argument("--b", type=int, required=True)
    args = ap.parse_args(argv)
    if args.cmd == "interval":
        r = interval_cmd(args.evidence, args.case, args.fx, args.socket, args.a, args.b)
        print(json.dumps(r, indent=1))
        return 0 if r.get("equal") else 1
    rep = verify_all(args.evidence, getattr(args, "case", None))
    if getattr(args, "report", None):
        with open(args.report, "w") as f:
            json.dump(rep, f, indent=1, sort_keys=True)
    for r in rep["cases"]:
        print("case %-6s checks=%-3d red=%d %s" % (r["case"], len(r["checks"]), len(r["red"]), r["red"]))
    print("TOTAL checks=%d red=%d" % (rep["checks_total"], rep["red_total"]))
    return 0 if rep["red_total"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
