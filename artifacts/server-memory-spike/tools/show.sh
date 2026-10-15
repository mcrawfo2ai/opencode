#!/bin/bash
python3 -c "
import json,sys
for l in open(sys.argv[1]):
  d=json.loads(l); print(d['label'].ljust(13), 'rss',str(d['rss_kb']//1024).rjust(5),'anon',str(d['anon_kb']//1024).rjust(5),'thr',str(d['threads']).rjust(3),'ptmx',d['ptmx'],'pts',d['pts'],'inotify',d['inotify'],'watches',d['inotify_watches'],'epoll',d['eventpoll'],'sock',d['socket'],'kids',d['children'],d['children_rss_kb']//1024)" $1
