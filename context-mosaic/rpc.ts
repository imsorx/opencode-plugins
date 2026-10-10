/**
 * Shared RPC definition: the server plugin measures the composed context for
 * every model request; the TUI plugin reads the latest measurement here.
 */
import { Rpc } from "@opencode/plugin/rpc"

export interface BreakdownPart {
  name: string
  tokens: number
}

export interface Breakdown {
  parts: BreakdownPart[]
  updatedAt: number
}

export const ContextGrid = Rpc.define({
  id: "context-mosaic",
  methods: {
    breakdown: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          parts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                tokens: { type: "number" },
              },
              required: ["name", "tokens"],
              additionalProperties: false,
            },
          },
          updatedAt: { type: "number" },
        },
        required: ["parts", "updatedAt"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})
