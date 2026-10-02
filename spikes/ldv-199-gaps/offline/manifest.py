#!/usr/bin/env python3
"""Generate MANIFEST.json / MANIFEST.sha256: every file under spikes/ldv-199-gaps with length and SHA-256.
Excludes the two manifest files themselves. usage: manifest.py <dir>"""
import hashlib, json, os, sys
root = os.path.abspath(sys.argv[1])
rows = []
for d, _, fs in os.walk(root):
    for f in sorted(fs):
        p = os.path.join(d, f)
        rel = os.path.relpath(p, root)
        if rel in ("MANIFEST.json", "MANIFEST.sha256"):
            continue
        if os.path.islink(p):
            raise SystemExit("symlink not allowed: " + rel)
        b = open(p, "rb").read()
        rows.append({"path": rel, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest(), "mode": oct(os.stat(p).st_mode & 0o777)})
rows.sort(key=lambda r: r["path"])
json.dump({"root": "spikes/ldv-199-gaps", "files": len(rows), "total_bytes": sum(r["bytes"] for r in rows), "inventory": rows}, open(os.path.join(root, "MANIFEST.json"), "w"), indent=1)
open(os.path.join(root, "MANIFEST.sha256"), "w").write("".join("%s  %s\n" % (r["sha256"], r["path"]) for r in rows))
print(len(rows), "files", sum(r["bytes"] for r in rows), "bytes")
