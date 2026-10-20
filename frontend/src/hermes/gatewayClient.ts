// The gateway client the Ink TUI uses: it starts `python -m tui_gateway.entry` (or connects to
// HERMES_TUI_GATEWAY_URL) and speaks its JSON-RPC. entry.ts makes one per pane.

export { GatewayClient } from '@tui/gatewayClient.js'
