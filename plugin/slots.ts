// Pure logic shared by the worker, the panel and the tests: slot settings and which workspace a
// press opens its terminal in. No host calls here.

export const SLOT_COUNT = 12

export type Slot = {
  /** 1-based slot number; Alt+F<index> opens it. */
  index: number
  label: string
  command: string
  shortcut: string
  enabled: boolean
}

export type WorkspaceRow = {
  id: string
  name: string
  branch: string | null
  hostId: string | null
}

export type FocusContext = {
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
} | null

export type Resolution = { workspaceId: string } | { error: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Every slot from the plugin settings, in slot order; a slot with no command is disabled. */
export function readSlots(settings: Record<string, unknown>): Slot[] {
  return Array.from({ length: SLOT_COUNT }, (_, offset) => {
    const index = offset + 1
    const command = text(settings[`slot${index}.command`])
    return {
      index,
      label: text(settings[`slot${index}.label`]) || `Slot ${index}`,
      command,
      shortcut: `Alt+F${index}`,
      enabled: command.length > 0
    }
  })
}

/** The slot a 1-based index names, or an error a person can act on. */
export function pickSlot(slots: Slot[], index: number): Slot | { error: string } {
  const slot = slots.find((candidate) => candidate.index === index)
  if (!slot) return { error: `There is no slot ${index}; slots run from 1 to ${SLOT_COUNT}.` }
  if (!slot.enabled) {
    return { error: `Slot ${index} has no command yet. Set it in Settings > Plugins > Toolkit for Orca.` }
  }
  return slot
}

/**
 * Finds the focused workspace's id. `workspace.readContext` gives only its name, branch and
 * terminals, so the name and branch are matched against `workspace.list`. When several
 * workspaces share both, a terminal of the focused workspace that an agent event already tied to
 * a workspace id decides (`owners`: terminal id -> workspace id).
 */
export function resolveWorkspace(
  context: FocusContext,
  workspaces: WorkspaceRow[],
  owners: ReadonlyMap<string, string> = new Map()
): Resolution {
  if (!context) return { error: 'No workspace is focused. Open a workspace first.' }
  const named = workspaces.filter(
    (row) => row.name === context.displayName && (row.branch ?? '') === context.branch
  )
  if (named.length === 1) return { workspaceId: named[0].id }
  const candidates = new Set(named.map((row) => row.id))
  for (const terminal of context.terminals) {
    const owner = owners.get(terminal.id)
    if (owner && (candidates.size === 0 || candidates.has(owner))) return { workspaceId: owner }
  }
  if (named.length === 0) {
    return { error: `Could not find the workspace "${context.displayName}" (${context.branch}).` }
  }
  return {
    error:
      `${named.length} workspaces are named "${context.displayName}" on branch ` +
      `${context.branch}. Rename one, or start an agent in this one first so its terminal ` +
      'identifies it.'
  }
}

/** Slots as editable text: one line per slot, `label | command`; an empty line is an empty slot. */
export function formatSlotLines(slots: Slot[]): string {
  const lines = slots.map((slot) => (slot.enabled ? `${slot.label} | ${slot.command}` : ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** The settings that `text` (see formatSlotLines) sets, for every slot; or why it cannot. */
export function parseSlotLines(text: string): Record<string, string> | { error: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > SLOT_COUNT) return { error: `At most ${SLOT_COUNT} lines, one per slot.` }
  const settings: Record<string, string> = {}
  for (let offset = 0; offset < SLOT_COUNT; offset += 1) {
    const line = (lines[offset] ?? '').trim()
    const bar = line.indexOf('|')
    if (line !== '' && bar < 0) return { error: `Line ${offset + 1} needs "label | command".` }
    const label = line === '' ? '' : line.slice(0, bar).trim()
    const command = line === '' ? '' : line.slice(bar + 1).trim()
    if (line !== '' && command === '') return { error: `Line ${offset + 1} has no command.` }
    settings[`slot${offset + 1}.label`] = label
    settings[`slot${offset + 1}.command`] = command
  }
  return settings
}

/** One line per enabled slot, for the status bar notification and the palette answer. */
export function describeSlots(slots: Slot[]): string {
  const enabled = slots.filter((slot) => slot.enabled)
  if (enabled.length === 0) return 'No slots are set. Add commands in Settings > Plugins > Toolkit for Orca.'
  return enabled.map((slot) => `${slot.shortcut}  ${slot.label}`).join('\n')
}
