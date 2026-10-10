/**
 * Server side of context-mosaic.
 *
 * Hooks the session `context` hook — which sees the fully assembled request
 * (system parts, tool definitions, message transcript) right before every
 * model call — and stores a token estimate of what the context is composed
 * of, per session. The TUI plugin reads it through the shared RPC.
 */
import { Plugin } from "@opencode/plugin"
import { ContextGrid } from "./rpc.ts"

/** chars-to-tokens heuristic (roughly 4 chars per token). */
const estimate = (value: string) => Math.ceil(value.length / 4)

const storageKey = (sessionID: string) => `context-mosaic:breakdown:${sessionID}`

const isMcpToolName = (name: string, servers: string[]): boolean =>
  name.includes("__") || servers.some((server) => name === server || name.startsWith(`${server}_`) || name.startsWith(`mcp__${server}`))

export default Plugin.define({
  id: "context-mosaic.server",
  async setup(ctx) {
    const mcpServers = async (): Promise<string[]> => {
      try {
        const raw = (await ctx.mcp.list()) as unknown
        const list = Array.isArray((raw as { data?: unknown })?.data)
          ? (raw as { data: unknown[] }).data
          : Array.isArray(raw)
            ? raw
            : []
        return list
          .map((item) => {
            if (typeof item === "string") return item
            if (Array.isArray(item)) return item[0]
            return (item as { name?: string })?.name
          })
          .filter((name): name is string => typeof name === "string" && name.length > 0)
      } catch {
        return []
      }
    }

    const registration = await ctx.session.hook("context", async (event) => {
      const servers = await mcpServers()

      // System prompt (includes env context, instructions, memory content).
      const system = (event.system ?? []).reduce((sum, part) => sum + estimate(String(part?.text ?? "")), 0)

      // Tool definitions: builtin vs MCP.
      let tools = 0
      let mcpDefs = 0
      for (const [name, definition] of Object.entries(event.tools ?? {})) {
        const size =
          estimate(definition?.description ?? "") + estimate(JSON.stringify(definition?.input ?? {}))
        if (isMcpToolName(name, servers)) mcpDefs += size
        else tools += size
      }

      // Transcript: user prompts, builtin tool results, replies, MCP results.
      let prompts = 0
      let results = 0
      let replies = 0
      let mcpResults = 0
      const messageSize = (message: unknown) => {
        const content = (message as { content?: Array<Record<string, unknown>> })?.content
        if (!Array.isArray(content)) return estimate(JSON.stringify(message ?? {}))
        let total = 0
        for (const part of content) {
          const type = part?.type
          if (type === "text" || type === "reasoning") {
            total += estimate(String(part?.text ?? ""))
          } else if (type === "tool-result") {
            total += estimate(JSON.stringify(part?.result ?? ""))
            const namespace = typeof part?.namespace === "string" ? part.namespace : ""
            const name = typeof part?.name === "string" ? part.name : ""
            const mcp = namespace.includes("mcp") || isMcpToolName(name, servers)
            if (mcp) mcpResults += total
            else results += total
            total = 0
          } else if (type === "tool-call") {
            total += estimate(JSON.stringify(part?.input ?? part?.args ?? ""))
          } else if (type === "media") {
            total += 1_500
          } else {
            total += estimate(JSON.stringify(part ?? {}))
          }
        }
        return total
      }

      for (const message of event.messages ?? []) {
        const role = (message as { role?: string })?.role
        const size = messageSize(message)
        // Tool-result parts were already attributed inside messageSize; the
        // remaining roles are user prompts (incl. tool-role wrapper messages) and
        // assistant replies.
        if (role === "assistant") replies += size
        else prompts += size
      }

      const mcp = mcpDefs + mcpResults
      const parts = (
        [
          ["system", system],
          ["tools", tools],
          ["mcp", mcp],
          ["prompts", prompts],
          ["results", results],
          ["replies", replies],
        ] as Array<[string, number]>
      )
        .filter(([, tokens]) => tokens > 0)
        .map(([name, tokens]) => ({ name, tokens: Math.max(1, tokens) }))

      await ctx.storage.set(storageKey(event.sessionID), { parts, updatedAt: Date.now() })
    })

    const rpcRegistration = await ctx.rpc.register(ContextGrid, {
      breakdown: async (input) => {
        const sessionID = (input as { sessionID?: string }).sessionID ?? ""
        const stored = await ctx.storage.get(storageKey(sessionID))
        if (!stored) return { parts: [], updatedAt: 0 }
        return stored as { parts: Array<{ name: string; tokens: number }>; updatedAt: number }
      },
    })

    return () => {
      void registration.dispose()
      void rpcRegistration.dispose()
    }
  },
})
