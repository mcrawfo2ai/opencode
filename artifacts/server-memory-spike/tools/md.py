import json,sys
print("| step | RSS MiB | anon MiB | threads | ptmx | pts | inotify fds (watches) | eventpoll | socket |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---:|")
for l in open(sys.argv[1]):
    d=json.loads(l)
    if d['label'].startswith(('N=0 boot','base','proto 2x')) and len(sys.argv)<3: continue
    print(f"| {d['label']} | {d['rss_kb']//1024} | {d['anon_kb']//1024} | {d['threads']} | {d['ptmx']} | {d['pts']} | {d['inotify']} ({d['inotify_watches']}) | {d['eventpoll']} | {d['socket']} |")
