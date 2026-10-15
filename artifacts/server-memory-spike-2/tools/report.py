# report.py RUN... : per-run checkpoint table + per-dir slope, from q.jsonl and mem/*.json
import json, os, sys

M = 1024 * 1024


def rows(run):
    out = {}
    for l in open(f"{run}/q.jsonl"):
        d = json.loads(l)
        out[d["label"]] = d
    return out


def mem(run, name):
    p = f"{run}/mem/{name}.json"
    return json.load(open(p)) if os.path.exists(p) else None


def table(run):
    r = rows(run)
    print(f"\n### {os.path.basename(run)}\n")
    print("| step | RSS MiB | anon MiB | HWM MiB | threads | ptmx | pts | inotify | socket | heap live MB | heap cap MB | objects | mimalloc MB | children (RSS MiB) |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for label, d in r.items():
        f = d["fds"]
        m = mem(run, label.split()[0]) if label.endswith("postgc") else None
        kids = ", ".join(f"{k}×{v} ({d['children_rss_kb'].get(k, 0) // 1024})" for k, v in d["children"].items()) or "—"
        heap = (f"{m['heapSize'] // M} | {m['heapCapacity'] // M} | {m['objectCount'] / 1e6:.2f} M | {m['mimalloc']['committed']['current'] // M}" if m else " | | | ")
        print(f"| {label} | {d['rss_kb'] // 1024} | {d['anon_kb'] // 1024} | {d['hwm_kb'] // 1024} | {d['threads']} | {f.get('ptmx', 0)} | {f.get('pts', 0)} | {f.get('inotify', 0)} | {f.get('socket', 0)} | {heap} | {kids} |")


def slope(run):
    r = rows(run)
    a, b = r.get("N=1 postgc"), r.get("N=20 postgc")
    ma, mb = mem(run, "N=1"), mem(run, "N=20")
    if not (a and b and ma and mb):
        return None
    kids = lambda d: sum(d["children_rss_kb"].values()) / 1024
    return {
        "run": os.path.basename(run),
        "rss_per_dir": (b["rss_kb"] - a["rss_kb"]) / 1024 / 19,
        "heap_live_per_dir": (mb["heapSize"] - ma["heapSize"]) / M / 19,
        "heap_cap_per_dir": (mb["heapCapacity"] - ma["heapCapacity"]) / M / 19,
        "objects_per_dir_k": (mb["objectCount"] - ma["objectCount"]) / 1000 / 19,
        "extra_per_dir": (mb["extraMemorySize"] - ma["extraMemorySize"]) / M / 19,
        "mimalloc_per_dir": (mb["mimalloc"]["committed"]["current"] - ma["mimalloc"]["committed"]["current"]) / M / 19,
        "threads_per_dir": (b["threads"] - a["threads"]) / 19,
        "children_rss_per_dir": (kids(b) - kids(a)) / 19,
        "n1_rss": a["rss_kb"] // 1024,
        "n20_rss": b["rss_kb"] // 1024,
    }


if __name__ == "__main__":
    runs = sys.argv[1:]
    print("| run | N=1 post-GC RSS | N=20 post-GC RSS | RSS/dir | heap live/dir | heap cap/dir | objects/dir | extra/dir | mimalloc/dir | threads/dir | children RSS/dir |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for run in runs:
        s = slope(run)
        if s:
            print(f"| {s['run']} | {s['n1_rss']} | {s['n20_rss']} | **{s['rss_per_dir']:.1f}** | {s['heap_live_per_dir']:.1f} | {s['heap_cap_per_dir']:.1f} | {s['objects_per_dir_k']:.0f} k | {s['extra_per_dir']:.1f} | {s['mimalloc_per_dir']:.1f} | {s['threads_per_dir']:.1f} | {s['children_rss_per_dir']:.0f} |")
    for run in runs:
        table(run)
