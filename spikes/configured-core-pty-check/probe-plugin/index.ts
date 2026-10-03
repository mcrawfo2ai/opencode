// Owned read-only registry probe. Loaded as a configured local directory next to the real plugin.
// It only inspects the launched host's tool registry through the plugin host API; it never executes tools.
export default {
  id: "spike-registry-probe",
  setup: async (ctx: { tool: { list(): Promise<ReadonlyArray<Record<string, unknown>>> } }) => {
    const tools = await ctx.tool.list()
    const rows = tools.map((tool) => ({
      name: typeof tool.name === "string" ? tool.name : null,
      id: typeof tool.id === "string" ? tool.id : null,
      keys: Object.keys(tool).sort(),
      executable: typeof tool.execute === "function",
    }))
    console.error("SPIKE_PROBE " + JSON.stringify({ t: performance.now(), count: rows.length, rows }))
  },
}
