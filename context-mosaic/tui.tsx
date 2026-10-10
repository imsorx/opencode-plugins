/**
 * Opencode Context — a sidebar grid of squares showing what is occupying the
 * current session's context window, measured from the composed request:
 *
 *   Opencode Context
 *   cache 80.0k · unc 25.1k
 *
 *   ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■ ■   (each square = limit/36 tokens)
 *   ■ ■ ■ ■ ■ ■■ ■ ■ ■ □ □
 *   ■ ■ ■ ◧ ◧ ▣ ▣ □ □ □ □ □
 *
 *   ■ system     6.1k   5%
 *   ■ tools      9.8k   8%
 *   ■ mcp        1.2k   1%
 *   ■ prompts    3.4k   3%
 *   ■ results   45.0k  38%
 *   ■ replies    9.9k   8%
 *   □ free      15.2k  13%
 *
 *   cache 80.0k · uncached 25.1k
 *   used 104.8k/120k  87%
 *
 * The structural parts are char/4 estimates taken from the hook that sees the
 * assembled context; cache vs uncached is the provider-wide split for the
 * latest request.
 *
 * Loaded by OpenCode through `plugins` (server: index.ts, TUI: tui.tsx).
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createResource, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { BoxRenderable, RGBA } from "@opentui/core"

const NUM_W = 8

/** Grid rows: each square represents limit / (ROWS x COLS) tokens. COLS
 * adapts to the measured sidebar width so the grid stretches edge-to-edge. */
const ROWS = 3
const DEFAULT_COLS = 12

interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface AssistantLike {
  type: "assistant"
  tokens?: TokenUsage
}

interface Part {
  name: string
  tokens: number
}

interface Breakdown {
  parts: Part[]
  updatedAt: number
}

interface Cell {
  name: string
  tokens: number
  color: string | RGBA
  outline?: boolean
}

function fmt(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`
  }
  return String(n)
}

/** Splits totalCells across cells proportionally (largest remainder), with a
 * minimum-visibility guarantee: every segment with real occupancy draws at
 * least one square, donated by the largest holder. Promoted squares are
 * marked partial so they render as half/third variants (◧/▣) reflecting the
 * segment's true fractional share instead of overstating a full ■. */
function allocate(cells: Array<Cell>, totalCells: number): Array<PlacedCell> {
  const sum = cells.reduce((s, x) => s + x.tokens, 0) || 1
  const shares = cells.map((cell) => {
    const frac = (cell.tokens / sum) * totalCells
    return { cell, frac, count: Math.floor(frac), partial: false }
  })
  let left = totalCells - shares.reduce((s, x) => s + x.count, 0)
  const byRemainder = [...shares].sort((a, b) => b.frac - Math.floor(b.frac) - (a.frac - Math.floor(a.frac)))
  for (const share of byRemainder) {
    if (left <= 0) break
    share.count++
    left--
  }
  if (left > 0 && shares.length > 0) {
    shares[shares.length - 1].count += left
    left = 0
  }
  // Visibility pass: promote zero-square segments to one square, donated from
  // the largest holder so the grid still sums to exactly totalCells. The
  // promoted square is a partial: its shade comes from the true remainder.
  for (const share of shares) {
    if (share.cell.tokens <= 0 || share.count > 0) continue
    const donors = shares.filter((s) => s !== share && s.count > 1).sort((a, b) => b.count - a.count)
    if (donors.length === 0) {
      share.count = 1
      share.partial = true
      break
    }
    donors[0].count--
    share.count = 1
    share.partial = true
  }
  return shares.map((s) => ({
    cell: s.cell,
    count: s.count,
    partial: s.partial,
    // True fractional share in whole squares (1 for fully realized cells).
    fraction: s.partial ? Math.max(0.15, Math.min(0.85, s.frac % 1 || 0.5)) : 1,
  }))
}

/** Square glyph family: solid ■ for realized squares, ◧ (half-filled) / ▣
 * (small-filled center) for partials — chosen from the same U+25xx block as
 * ■/□ so heights match; the older shade blocks (░▒▓) render taller in many
 * terminal fonts. */
function squareGlyph(fraction: number): string {
  return fraction >= 0.5 ? "◧" : "▣"
}

type PlacedCell = {
  cell: Cell
  count: number
  partial?: boolean
  fraction: number
}

function cellGlyph(placed: PlacedCell): string {
  if (placed.cell.outline) return "□"
  return placed.partial ? squareGlyph(placed.fraction) : "■"
}


function ContextPanel(props: { sessionID: string }) {
  const context = usePlugin()
  const [cols, setCols] = createSignal(DEFAULT_COLS)
  let measureBox: BoxRenderable | undefined
  const measure = (box: BoxRenderable) => {
    const width = typeof box.width === "number" ? box.width : 0
    if (width > 0) {
      // Each square occupies two terminal cells ("■ ").
      setCols(Math.min(40, Math.max(6, Math.floor(width / 2))))
    }
  }
  const [snapshot, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      try {
        const response = (await context.client.rpc.call({
          rpcID: "context-mosaic",
          method: "breakdown",
          input: { sessionID },
        })) as { output?: unknown }
        const data = (response?.output ?? null) as Breakdown | null
        return data && Array.isArray(data.parts) ? data : ({ parts: [], updatedAt: 0 } as Breakdown)
      } catch {
        return { parts: [], updatedAt: 0 } as Breakdown
      }
    },
  )

  const messages = () => context.data.session.message.list(props.sessionID)
  const sync = () => {
    void context.data.session.message.sync(props.sessionID).catch(() => undefined)
  }
  sync()
  const timer = setInterval(() => {
    sync()
    void refetch()
  }, 30_000)
  const stopUsage = context.data.on("session.usage.updated", () => {
    sync()
    void refetch()
  })
  onCleanup(() => {
    clearInterval(timer)
    stopUsage()
  })

  // Latest completed assistant step: the provider-wide context occupancy for
  // this session. Falls back to the last step that has tokens — a freshly
  // sent turn creates an assistant message whose tokens are only set when the
  // step finishes.
  const usage = () => {
    const list = messages()
    if (!list) return undefined
    const assistant = list
      .map((m) => (m.type === "assistant" ? (m as unknown as AssistantLike) : undefined))
      .filter((m): m is AssistantLike => m !== undefined)
    const measured = assistant.filter((m) => m.tokens)
    const tokens = measured[measured.length - 1]?.tokens
    if (!tokens) return undefined
    const used = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    return { tokens, used }
  }

  const model = () => {
    const current = context.ui.model.current()
    if (!current) return undefined
    const location = context.location ?? context.data.location.default()
    return context.data.location.model.list(location)?.find(
      (m) => m.providerID === current.providerID && m.modelID === current.modelID,
    )
  }

  const limit = () => model()?.limit?.context ?? 0

  // Occupancy cells: hook-measured parts + free space, mapped to deliberately
  // distinct theme tokens: semantic feedback hues (info/warning/success) for
  // tools/mcp/results, and far-apart steps of the accent/interactive ramps for
  // the rest. Earlier near-duplicates (tools==replies, system==prompts) came
  // from giving different parts the same step on different ramps.
  const cells = (): Cell[] => {
    const u = usage()
    const data = snapshot()
    const palette: Record<string, string | RGBA> = {
      system: context.theme.hue.accent[800],
      tools: context.theme.text.feedback.info.base,
      mcp: context.theme.text.feedback.warning.base,
      prompts: context.theme.hue.interactive[600],
      results: context.theme.text.feedback.success.base,
      replies: context.theme.hue.accent[300],
      free: context.theme.hue.neutral[500],
    }
    const measured = data?.parts ?? []
    const list: Cell[] = measured.map((part) => ({
      name: part.name,
      tokens: part.tokens,
      color: palette[part.name] ?? context.theme.hue.neutral[700],
    }))
    const l = limit()
    if (l > 0) {
      const profiled = measured.reduce((sum, part) => sum + part.tokens, 0)
      const occupied = Math.max(profiled, u?.used ?? 0)
      const free = Math.max(0, l - occupied)
      if (free > 0) list.push({ name: "free", tokens: free, color: palette["free"], outline: true })
    }
    return list
  }

  const allocatedByCell = () => {
    const map = new Map<Cell, PlacedCell>()
    for (const placed of allocate(cells(), ROWS * cols())) map.set(placed.cell, placed)
    return map
  }

  // Grid rows: consecutive squares of the same cell AND glyph merged into
  // spans (solid squares merge; partials keep their own shade), padded to fill
  // the full row so the grid always stretches edge-to-edge.
  const gridRows = () => {
    const total = ROWS * cols()
    const allocated: PlacedCell[] = allocate(cells(), total)
    const filler: Cell = { name: "free", tokens: 0, color: context.theme.hue.neutral[500], outline: true }
    const rows: Array<Array<{ span: number; cell: Cell; glyph: string }>> = []
    let current: Array<{ span: number; cell: Cell; glyph: string }> = []
    let used = 0
    const pushCell = (cell: Cell, glyph: string, count: number) => {
      let remaining = count
      while (remaining > 0) {
        if (used >= cols()) {
          rows.push(current)
          current = []
          used = 0
        }
        const last = current[current.length - 1]
        const take = Math.min(remaining, cols() - used)
        if (last && last.cell === cell && last.glyph === glyph) {
          last.span += take
        } else {
          current.push({ span: take, cell, glyph })
        }
        used += take
        remaining -= take
      }
    }
    for (const placed of allocated) pushCell(placed.cell, cellGlyph(placed), placed.count)
    const padding = total - allocated.reduce((sum, x) => sum + x.count, 0)
    if (padding > 0) pushCell(filler, "□", padding)
    if (current.length > 0) rows.push(current)
    return rows
  }

  return (
    <box flexDirection="column" width="100%">
      <box ref={measureBox} width="100%" height={0} onSizeChange={() => measureBox && measure(measureBox)} />
      <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
        Context Breakdown
      </text>
      <Show when={usage()} fallback={undefined}>
        {(u) => (
          <text fg={context.theme.text.muted}>
            {`${limit() > 0 ? `${fmt(limit())} · ` : ""}cache ${fmt(u().tokens.cache.read)} · unc ${fmt(u().tokens.input + u().tokens.cache.write)}`}
          </text>
        )}
      </Show>
      <Show
        when={snapshot.state !== "pending" && (usage() || (snapshot()?.parts?.length ?? 0) > 0)}
        fallback={<text fg={context.theme.text.muted}>{snapshot.state === "pending" ? "loading…" : "no usage yet"}</text>}
      >
        <box flexDirection="column" width="100%" gap={1}>
          <box flexDirection="column" marginTop={1}>
            <For each={gridRows()}>
              {(spans) => (
                <box flexDirection="row" height={1}>
                  <For each={spans}>
                    {(span) => (
                      <text fg={span.cell.color}>{`${span.glyph} `.repeat(span.span)}</text>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
          <box flexDirection="column">
            <For each={cells()}>
              {(cell) => {
                const total = limit() || usage()?.used || 0
                const placed = allocatedByCell().get(cell) ?? { cell, count: 0, partial: false, fraction: 0 }
                const glyph = cell.outline ? "□" : placed.partial ? squareGlyph(placed.fraction) : "■"
                return (
                  <box flexDirection="row" height={1} width="100%">
                    <text fg={cell.color}>{`${glyph} `}</text>
                    <text fg={context.theme.text.muted}>{cell.name}</text>
                    <box flexGrow={1} />
                    <text fg={context.theme.text.muted}>
                      {`${fmt(cell.tokens).padStart(NUM_W)}${total > 0 ? `  ${Math.max(0, Math.round((cell.tokens / total) * 100)).toString().padStart(3)}%` : ""}`}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "context-mosaic",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => <ContextPanel sessionID={input.sessionID} />,
    })
    return () => unregister()
  },
})
