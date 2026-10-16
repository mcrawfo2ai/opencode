# arenas.py PID: classify anon mappings: glibc arena heaps (64MiB-aligned rw+--- pairs), 8MiB thread stacks, others
import sys, re, collections
pid = sys.argv[1]
maps = []; cur = None
for line in open(f"/proc/{pid}/smaps"):
    if re.match(r"^[0-9a-f]+-[0-9a-f]+ ", line):
        p = line.split(None, 5); a, b = (int(x, 16) for x in p[0].split("-"))
        cur = dict(a=a, b=b, perm=p[1], name=p[5].strip() if len(p) > 5 else "", rss=0); maps.append(cur)
    elif line.startswith("Rss:"): cur["rss"] = int(line.split()[1])
ARENA = 64 << 20
agg = collections.defaultdict(lambda: [0, 0])
for m in maps:
    if m["name"]: k = "named:" + (m["name"].rsplit("/", 1)[-1] if m["name"].startswith("/") else m["name"])[:25]
    elif m["a"] % ARENA == 0 and m["perm"] == "rw-p" and (m["b"] - m["a"]) <= ARENA: k = "glibc-arena-heap(64M aligned)"
    elif (m["b"] - m["a"]) in (8 << 20, (8 << 20) + 4096) and m["perm"] == "rw-p": k = "8MiB stack-like"
    else: k = "other-anon"
    agg[k][0] += 1; agg[k][1] += m["rss"]
for k, (n, r) in sorted(agg.items(), key=lambda x: -x[1][1])[:8]:
    print(f"  {k:32s} n={n:5d} rss={r/1024:8.1f}MiB")
