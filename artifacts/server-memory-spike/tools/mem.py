import json, sys
M = 1024 * 1024
for f in sys.argv[1:]:
    d = json.load(open(f))
    mi = d["mimalloc"] or {}
    print(f.rsplit("/", 1)[-1].ljust(9),
          f"rss(postGC)={d['after']['rss']//M}M heapUsed={d['after']['heapUsed']//M}M heapTotal={d['after']['heapTotal']//M}M",
          f"jscHeapSize={d['heapSize']//M}M cap={d['heapCapacity']//M}M extra={d['extraMemorySize']//M}M ext={d['after']['external']//M}M ab={d['after']['arrayBuffers']//M}M",
          f"objs={d['objectCount']} globals={d['globalObjectCount']}",
          f"mimalloc_committed={mi.get('committed',{}).get('current',0)//M}M peak={mi.get('committed',{}).get('peak',0)//M}M mi_threads={mi.get('threads',{}).get('current')} huge={mi.get('malloc_huge',{}).get('current',0)//M}M abandoned_pages={mi.get('pages_abandoned',{}).get('current')}")
