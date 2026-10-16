// Stub OpenAI-compatible chat-completions server for spike 2. Scripts a tool-call sequence per session,
// selected by "SCRIPT:<name>" in the first user message, keyed by the number of tool results so far.
// Serves every provider entry that points at it; model ids are not checked.
import { readFileSync } from "fs"

const port = Number(process.argv[2] ?? 4999)
let calls = 0

type Step = { name: string; args: Record<string, unknown> }

function goScript(dir: string, n: number): Step[] {
  const [a, b] = readFileSync(`${dir}/SPIKE_FILES`, "utf8").trim().split("\n")
  const f = `${dir}/internal/spike/spike_${n}.go`
  return [
    { name: "bash", args: { command: "ls -la && git status --short | head -20 && echo done", description: "list files" } },
    { name: "read", args: { filePath: `${dir}/${a}` } },
    { name: "bash", args: { command: "find . -name '*.go' | head -300 | xargs wc -l | tail -1", description: "count lines" } },
    { name: "read", args: { filePath: `${dir}/README.md` } },
    { name: "grep", args: { pattern: "func New", path: dir, include: "*.go" } },
    { name: "write", args: { filePath: f, content: `package spike\n\nfunc F${n}() int { return ${n} }\n` } },
    { name: "edit", args: { filePath: f, oldString: `return ${n} }`, newString: `return ${n} + 1 }` } },
    { name: "bash", args: { command: "for i in 1 2 3; do echo line $i; done; sleep 1", description: "loop" } },
    { name: "read", args: { filePath: `${dir}/${b}` } },
  ]
}

// Q7: large tool outputs. "bigedit" uses edit (non-gpt model), "bigpatch" uses apply_patch (gpt-* model).
function bigScript(dir: string, kind: string): Step[] {
  const steps: Step[] = [
    { name: "bash", args: { command: "head -c 3750000 /dev/urandom | base64 -w 120", description: "5MB output" } },
    { name: "read", args: { filePath: `${dir}/big/big50k.txt`, limit: 50000 } },
  ]
  if (kind === "bigedit") {
    const text = readFileSync(`${dir}/big/big100k.txt`, "utf8")
    steps.push({ name: "edit", args: { filePath: `${dir}/big/big100k.txt`, oldString: text, newString: text.replaceAll("line", "LINE") } })
  }
  if (kind === "bigpatch") {
    const text = readFileSync(`${dir}/big/big100k.txt`, "utf8")
    const lines = text.split("\n").filter(Boolean)
    steps.push({ name: "apply_patch", args: { patchText: `*** Begin Patch\n*** Delete File: ${dir}/big/big100k.txt\n*** End Patch` } })
    steps.push({
      name: "apply_patch",
      args: { patchText: `*** Begin Patch\n*** Add File: ${dir}/big/big100k-new.txt\n${lines.map((l) => "+" + l.toUpperCase()).join("\n")}\n*** End Patch` },
    })
  }
  return steps
}

function sse(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function userText(messages: { role: string; content: unknown }[]) {
  const first = messages.find((m) => m.role === "user")
  if (!first) return ""
  if (typeof first.content === "string") return first.content
  return JSON.stringify(first.content)
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stub", object: "model" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("nf", { status: 404 })
    calls++
    const body = await req.json()
    const all = JSON.stringify(body.messages)
    const dir = all.match(/Working directory: ([^\\"<]+?)\\n/)?.[1] ?? "."
    const script = userText(body.messages).match(/SCRIPT:(\w+)/)?.[1] ?? "go"
    const seq = Number(userText(body.messages).match(/SEQ:(\d+)/)?.[1] ?? calls)
    const done = body.messages.filter((m: { role: string }) => m.role === "tool").length
    // "long": ~60 tool turns in one session (reviewer/implementer seats run 50-200).
    const plan = script === "go" ? goScript(dir, seq) : script === "long" ? [0, 1, 2, 3, 4, 5].flatMap((i) => goScript(dir, seq * 10 + i)) : bigScript(dir, script)
    // When the PTY plugin is loaded (as in production), the agent also runs a short-lived PTY and reads it.
    if ((script === "go" || script === "long") && body.tools?.some((t: { function?: { name?: string } }) => t.function?.name === "pty_spawn")) {
      const ptyID = all.match(/ID: (pty_[0-9a-f]+)/)?.[1] ?? "pty_unknown"
      plan.splice(8, 0,
        { name: "pty_spawn", args: { command: "bash", args: ["-c", "go version; ls | head -5; sleep 1; exit 0"], description: "short pty" } },
        { name: "bash", args: { command: "sleep 2", description: "wait for pty" } },
        { name: "pty_read", args: { id: ptyID } },
      )
    }
    const base = { id: `chatcmpl-${calls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model }
    const chunks: string[] = []
    // Title/summary calls (no tools) and the final turn get plain text.
    if (done < plan.length && body.tools?.length) {
      const step = plan[done]!
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `Step ${done}.` } }] }))
      chunks.push(
        sse({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }],
              },
            },
          ],
        }),
      )
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }))
    } else {
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "All done. " + "x".repeat(200) } }] }))
      chunks.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
    }
    chunks.push(sse({ ...base, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } }))
    chunks.push("data: [DONE]\n\n")
    return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } })
  },
})
console.log(`stub2 on ${port}`)
