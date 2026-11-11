// The panel <-> worker contract, declared once: plugin/panel.tsx and plugin/worker.ts both read it.
import type { Slot } from './slots'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Every slot from the plugin settings, in slot order. */
    'slots.list': { output: { slots: Slot[] } }
    /** Opens slot `index` (1-12) in the focused workspace; rejects with a readable message. */
    'slots.open': { input: { index: number }; output: { terminalId: string; title: string } }
    /** Replaces every slot from `label | command` lines (line n is slot n); answers the new slots. */
    'slots.import': { input: { text: string }; output: { slots: Slot[] } }
  }
  interface PluginPanelEvents {
    /** Posted after the person changes a slot in Settings. */
    'slots.changed': Record<string, never>
  }
}
