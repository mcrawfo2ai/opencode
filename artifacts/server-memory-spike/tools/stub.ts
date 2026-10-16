// Stub OpenAI-compatible chat-completions server. Scripts a fixed tool-call sequence per session,
// keyed by the number of tool results already in the request.
const port = Number(process.argv[2] ?? 4999)
let calls = 0

function steps(dir: string) {
  return [
    { name: "bash", args: { command: "ls -la && git status --short && echo done", description: "list files" } },
    { name: "read", args: { filePath: `${dir}/src/index.ts` } },
    { name: "bash", args: { command: "find . -type f -not -path './.git/*' | head -50 | xargs wc -l", description: "count lines" } },
    { name: "read", args: { filePath: `${dir}/README.md` } },
    { name: "grep", args: { pattern: "function", path: dir } },
    { name: "bash", args: { command: "for i in 1 2 3; do echo line $i; done; sleep 1", description: "loop" } },
    { name: "read", args: { filePath: `${dir}/src/util.py` } },
  ]
}

function sse(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`
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
    const sys = JSON.stringify(body.messages)
    const dir = sys.match(/Working directory: ([^\\"<]+?)\\n/)?.[1] ?? "."
    const done = body.messages.filter((m: { role: string }) => m.role === "tool").length
    const plan = steps(dir)
    const id = `chatcmpl-${calls}`
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub" }
    const chunks: string[] = []
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
                tool_calls: [
                  { index: 0, id: `call_${calls}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } },
                ],
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
console.log(`stub on ${port}`)
