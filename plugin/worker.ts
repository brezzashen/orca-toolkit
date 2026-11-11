// The worker behind every surface: Alt+F1-F12 and the palette run `slot-<n>`, the panel calls
// `slots.list` / `slots.open`, the status bar item runs `show`. Opening a slot creates a terminal
// in the focused workspace that runs the slot's command. Workspace discovery is limited to
// what the plugin host exposes; paired desktops can report no context (upstream #40723).
import type { OrcaWorkerApi } from 'orca/worker'
import {
  describeSlots,
  parseSlotLines,
  pickSlot,
  readSlots,
  resolveWorkspace,
  SLOT_COUNT,
  type Slot
} from './slots'

export type Opened = { terminalId: string; title: string }

async function currentSlots(orca: OrcaWorkerApi): Promise<Slot[]> {
  return readSlots(await orca.settings.get())
}

export default function activate(orca: OrcaWorkerApi): void {
  // terminal id -> workspace id, learned from agent events; breaks ties between same-named workspaces.
  const owners = new Map<string, string>()
  orca.events.on('agent.status.changed', (event) => {
    if (event.terminalId && event.workspaceId) owners.set(event.terminalId, event.workspaceId)
  })

  async function open(index: number): Promise<Opened> {
    const slot = pickSlot(await currentSlots(orca), index)
    if ('error' in slot) throw new Error(slot.error)
    const context = await orca.host.call('workspace.readContext', {})
    const { workspaces } = await orca.host.call('workspace.list', {})
    const target = resolveWorkspace(context, workspaces, owners)
    if ('error' in target) throw new Error(target.error)
    const { terminalId } = await orca.host.call('terminal.create', {
      workspaceId: target.workspaceId,
      title: slot.label,
      command: slot.command
    })
    // terminal.create runs in the background: without this the desktop never adopts the new
    // terminal as a tab (Orca 1.4.255 lists it as orphaned). Desktop only; other clients skip it.
    await orca.host.call('workspace.open', { workspaceId: target.workspaceId }).catch((error: unknown) => {
      orca.log(`workspace.open skipped: ${error instanceof Error ? error.message : String(error)}`)
    })
    orca.log(`slot ${index} opened ${terminalId} in ${target.workspaceId}`)
    return { terminalId, title: slot.label }
  }

  async function openFromShortcut(index: number): Promise<string> {
    try {
      const opened = await open(index)
      return `Opened ${opened.title}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await orca.host.call('notifications.show', { title: 'Toolkit for Orca', body: message }).catch(() => undefined)
      return message
    }
  }

  for (let index = 1; index <= SLOT_COUNT; index += 1) {
    orca.commands.register(`slot-${index}`, () => openFromShortcut(index))
  }

  orca.commands.register('show', async () => {
    const body = describeSlots(await currentSlots(orca))
    await orca.host.call('notifications.show', { title: 'Toolkit for Orca', body }).catch(() => undefined)
    return body
  })

  orca.panels.handle('slots.list', async () => ({ slots: await currentSlots(orca) }))
  orca.panels.handle('slots.open', async ({ index }) => open(index))
  orca.panels.handle('slots.import', async ({ text }) => {
    const settings = parseSlotLines(text)
    if ('error' in settings) throw new Error(settings.error)
    for (const [key, value] of Object.entries(settings)) await orca.settings.set(key, value)
    return { slots: await currentSlots(orca) }
  })
  orca.settings.onDidChange(() => orca.panels.post('slots.changed', {}))
}
