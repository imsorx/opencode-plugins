/**
 * OpenCode Quota bars in the sidebar (5-hour / weekly / monthly). Bars are
 * full-height flex strips spanning the sidebar width; a marginTop gap
 * separates the rows so adjacent bars don't fuse:
 *
 *   Quota Status
 *   5h   █████░░░░░░   13%   4h
 *   wk   ████████░░░   55%   2d
 *   mo   ██░░░░░░░░░   27%  30d
 *
 * Loaded by OpenCode through `plugins` in cli.json (CLI plugin, ./tui entry).
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createResource, createSignal, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { BoxRenderable } from "@opentui/core"

// Interval between background polls while idle.
const POLL_MS = 60_000

type MeterKey = "fiveHour" | "week" | "month"

interface Meter {
  startsAt?: string
  resetsAt?: string
  limitMicroCents: string
  usedMicroCents: string
}

interface GoStatus {
  product?: string
  resumability?: string
  access?: {
    startsAt?: string
    endsAt?: string
    meters?: Partial<Record<MeterKey, Meter>>
  }
}

interface ConsoleCredential {
  server: string
  access: string
  orgID: string
}

/** Picks the active OpenCode Console credential and its signing context. */
async function consoleCredential(client: any): Promise<ConsoleCredential | undefined> {
  const credentials = await client.credential.list()
  const entry =
    credentials?.find((c: any) => c.integrationID === "opencode" && c.active) ??
    credentials?.find((c: any) => c.integrationID === "opencode")
  const value = entry?.value
  if (!value || value.type !== "oauth") return undefined
  const metadata = value.metadata ?? {}
  const server = typeof metadata.server === "string" ? metadata.server : "https://opencode.ai/console"
  const orgID = typeof metadata.orgID === "string" ? metadata.orgID : undefined
  if (!orgID) return undefined
  return { server: server.replace(/\/$/, ""), access: value.access, orgID }
}

async function fetchGoStatus(client: any): Promise<{ status?: GoStatus; state: "ok" | "no-credential" | "error" }> {
  let credential: ConsoleCredential | undefined
  try {
    credential = await consoleCredential(client)
  } catch {
    credential = undefined
  }
  if (!credential) return { state: "no-credential" }
  try {
    const response = await fetch(`${credential.server}/api/go/status`, {
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "x-org-id": credential.orgID,
        Accept: "application/json",
      },
    })
    if (!response.ok) return { state: "error" }
    const status = (await response.json()) as GoStatus
    return { status, state: "ok" }
  } catch {
    return { state: "error" }
  }
}

function usedPercent(meter: Meter): number {
  const limit = Number(meter.limitMicroCents)
  const used = Number(meter.usedMicroCents)
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(999, (used / limit) * 100)
}

function resetIn(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

function UsagePanel() {
  const context = usePlugin()
  const [snapshot, { refetch }] = createResource(() => fetchGoStatus(context.client))

  // Poll periodically, and right after session usage changes or credentials change.
  const timer = setInterval(() => void refetch(), POLL_MS)
  const stopUsage = context.data.on("session.usage.updated", () => void refetch())
  const stopCredential = context.data.on("credential.updated", () => void refetch())
  onCleanup(() => {
    clearInterval(timer)
    stopUsage()
    stopCredential()
  })

  const meters = () => {
    const raw = snapshot()?.status?.access?.meters ?? {}
    const entries: Array<{ label: string; meter: Meter }> = []
    if (raw.fiveHour) entries.push({ label: "5h", meter: raw.fiveHour })
    if (raw.week) entries.push({ label: "wk", meter: raw.week })
    if (raw.month) entries.push({ label: "mo", meter: raw.month })
    return entries
  }

  const ready = () => snapshot.state !== "pending" && meters().length > 0

  // Bars are glyph strips of full-height blocks (U+2588) drawn as foreground
  // color, so both the fill and the unfilled track are clearly visible
  // regardless of surface tokens. Columns adapt to the sidebar width; rows are
  // separated by a marginTop gap.
  const [cols, setCols] = createSignal(14)
  let measureBox: BoxRenderable | undefined
  const measure = (box: BoxRenderable) => {
    const width = typeof box.width === "number" ? box.width : 0
    if (width > 0) {
      // Reserve space for the label (4), percent (5) and reset (4) columns.
      setCols(Math.min(40, Math.max(8, Math.floor(width) - 13)))
    }
  }

  return (
    <box flexDirection="column" width="100%">
      <box ref={measureBox} width="100%" height={0} onSizeChange={() => measureBox && measure(measureBox)} />
      <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>Quota Status</text>
      <Show
        when={ready()}
        fallback={<text fg={context.theme.text.muted}>{snapshot.state === "pending" ? "loading…" : "not connected"}</text>}
      >
        <For each={meters()}>
          {(entry) => {
            const percent = () => usedPercent(entry.meter)
            const filled = () =>
              Math.max(1, Math.min(cols(), Math.round((Math.min(100, percent()) / 100) * cols())))
            const color = () =>
              percent() >= 90
                ? context.theme.text.feedback.error.base
                : percent() >= 70
                  ? context.theme.text.feedback.warning.base
                  : context.theme.text.feedback.success.base
            return (
              <box flexDirection="row" height={1} marginTop={1}>
                <text fg={context.theme.text.muted}>{`${entry.label.padEnd(3)} `}</text>
                <text fg={color()}>{"█".repeat(filled())}</text>
                <text fg={context.theme.hue.neutral[600]}>{"█".repeat(cols() - filled())}</text>
                <text fg={color()}>{` ${Math.round(percent()).toString().padStart(3)}%`}</text>
                <Show when={resetIn(entry.meter.resetsAt)}>
                  {(left) => (
                    <text fg={context.theme.text.muted}>{` ${String(left()).padEnd(3)}`}</text>
                  )}
                </Show>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "quota-bars",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => <UsagePanel />,
    })
    return () => unregister()
  },
})
