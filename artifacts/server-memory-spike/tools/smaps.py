# smaps.py PID -> RSS by mapping class, plus top anon mappings
import sys, re, collections
pid = sys.argv[1]
maps = []; cur = None
for line in open(f"/proc/{pid}/smaps"):
    if re.match(r"^[0-9a-f]+-[0-9a-f]+ ", line):
        parts = line.split(None, 5)
        a, b = (int(x, 16) for x in parts[0].split("-"))
        cur = {"start": a, "size": (b - a) // 1024, "perm": parts[1], "name": parts[5].strip() if len(parts) > 5 else "", "Rss": 0, "Anonymous": 0}
        maps.append(cur)
    else:
        k, _, v = line.partition(":")
        if k in ("Rss", "Anonymous"): cur[k] = int(v.split()[0])
def cls(m):
    n = m["name"]
    if n.startswith("/") and "opencode" in n and n.endswith("opencode"): return "binary"
    if n.startswith("/"): return "file:" + n.rsplit("/", 1)[-1][:30]
    if n: return n
    if m["size"] in (8192, 8196, 8188): return "anon 8MiB (thread stack?)"
    if m["size"] >= 1024 * 1024: return "anon >=1GiB reserve"
    return "anon"
agg = collections.defaultdict(lambda: [0, 0, 0])
for m in maps:
    a = agg[cls(m)]; a[0] += 1; a[1] += m["Rss"]; a[2] += m["Anonymous"]
tot = sum(m["Rss"] for m in maps)
print(f"total Rss {tot//1024} MiB in {len(maps)} mappings")
for k, (n, r, an) in sorted(agg.items(), key=lambda x: -x[1][1])[:14]:
    print(f"  {k[:40]:40s} n={n:5d} rss={r//1024:6d}MiB anon={an//1024:6d}MiB")
anon = sorted([m for m in maps if not m["name"]], key=lambda m: -m["Rss"])
hist = collections.Counter()
for m in anon:
    s = m["size"]; b = "<1M" if s < 1024 else "<8M" if s < 8192 else "8M" if s <= 8196 else "<64M" if s < 65536 else "<1G" if s < 1048576 else ">=1G"
    hist[b] += m["Rss"]
print("  anon rss by vsize bucket (MiB):", {k: v // 1024 for k, v in sorted(hist.items())})
print("  top anon:", [(hex(m["start"]), m["size"] // 1024, m["Rss"] // 1024) for m in anon[:8]], "(addr, vsizeMiB, rssMiB)")
