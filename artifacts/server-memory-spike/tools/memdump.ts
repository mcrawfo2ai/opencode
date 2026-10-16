// THROWAWAY measurement instrument (spike). On SIGUSR2: full GC, then dump JS heap + mimalloc stats.
import path from "path"
import { existsSync, writeFileSync } from "fs"
import { writeHeapSnapshot } from "node:v8"
import { heapStats, memoryUsage } from "bun:jsc"

let n = 0
export function start() {
  const dir = process.env.MEMDUMP_DIR
  if (!dir) return
  process.on("SIGUSR2", () => {
    n++
    const before = process.memoryUsage()
    Bun.gc(true)
    Bun.gc(true)
    const after = process.memoryUsage()
    const h = heapStats()
    const mi = h.mimalloc as any
    const types = Object.entries(h.objectTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
    const out = {
      n,
      before,
      after,
      jsc: memoryUsage(),
      heapSize: h.heapSize,
      heapCapacity: h.heapCapacity,
      extraMemorySize: h.extraMemorySize,
      objectCount: h.objectCount,
      globalObjectCount: h.globalObjectCount,
      protectedObjectCount: h.protectedObjectCount,
      types,
      mimalloc: mi && {
        committed: mi.committed,
        reserved: mi.reserved,
        process: mi.process,
        pages: mi.pages,
        pages_abandoned: mi.pages_abandoned,
        threads: mi.threads,
        malloc_normal: mi.malloc_normal,
        malloc_huge: mi.malloc_huge,
        heaps: mi.heaps,
        arena_count: mi.arena_count,
        purged: mi.purged,
        reset: mi.reset,
      },
    }
    writeFileSync(path.join(dir, `mem-${n}.json`), JSON.stringify(out, null, 1))
    if (existsSync(path.join(dir, "want-snapshot")))
      writeHeapSnapshot(path.join(dir, `heap-${n}.heapsnapshot`))
    writeFileSync(path.join(dir, `done-${n}`), "")
  })
}

export * as MemDump from "./memdump"
