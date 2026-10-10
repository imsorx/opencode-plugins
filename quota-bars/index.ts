/**
 * Server entrypoint for quota-bars.
 *
 * The plugin itself renders only in the TUI (`./tui`); this no-op entry lets
 * the server resolve the package so the CLI auto-loads the TUI part from the
 * `opencode.json` plugin list. Importantly it never touches credentials — all
 * Go usage data is fetched client-side in `tui.tsx`.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "quota-bars.server",
  setup() {},
})
