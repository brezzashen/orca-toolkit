import { assert, test } from 'orca/testing'
import { describeSlots, formatSlotLines, parseSlotLines, pickSlot, readSlots, resolveWorkspace, SLOT_COUNT } from './slots'

const rows = [
  { id: 'w-a', name: 'app', branch: 'main', hostId: 'local' },
  { id: 'w-b', name: 'api', branch: 'main', hostId: 'local' },
  { id: 'w-c', name: 'api', branch: 'main', hostId: 'remote-1' }
]

test('reads twelve slots and disables the ones without a command', () => {
  const slots = readSlots({ 'slot2.label': ' Work ', 'slot2.command': ' claude ', 'slot3.label': 'Idle' })
  assert.equal(slots.length, SLOT_COUNT)
  assert.deepEqual(slots[1], { index: 2, label: 'Work', command: 'claude', shortcut: 'Alt+F2', enabled: true })
  assert.equal(slots[0].label, 'Slot 1')
  assert.equal(slots[2].enabled, false)
  assert.match(String((pickSlot(slots, 3) as { error: string }).error), /no command yet/)
  assert.match(String((pickSlot(slots, 13) as { error: string }).error), /no slot 13/)
  assert.equal(describeSlots(slots), 'Alt+F2  Work')
  assert.match(describeSlots(readSlots({})), /No slots are set/)
})

test('a unique name and branch picks the workspace', () => {
  const context = { branch: 'main', displayName: 'app', terminals: [] }
  assert.deepEqual(resolveWorkspace(context, rows), { workspaceId: 'w-a' })
})

test('same-named workspaces are told apart by a terminal an agent event tied to one', () => {
  const context = { branch: 'main', displayName: 'api', terminals: [{ id: 't-9' }] }
  assert.match(String((resolveWorkspace(context, rows) as { error: string }).error), /2 workspaces/)
  assert.deepEqual(resolveWorkspace(context, rows, new Map([['t-9', 'w-c']])), { workspaceId: 'w-c' })
  // An owner outside the same-named set is not trusted.
  assert.match(String((resolveWorkspace(context, rows, new Map([['t-9', 'w-a']])) as { error: string }).error), /2 workspaces/)
})

test('no focus and an unknown workspace explain themselves', () => {
  assert.match(String((resolveWorkspace(null, rows) as { error: string }).error), /No workspace is focused/)
  const unknown = { branch: 'dev', displayName: 'web', terminals: [] }
  assert.match(String((resolveWorkspace(unknown, rows) as { error: string }).error), /Could not find/)
})

test('slot lines round-trip and reject what cannot be a slot', () => {
  const settings = parseSlotLines('Work | CLAUDE_CONFIG_DIR=~/a claude\n\nHome | codex --profile home | tee x\n')
  assert.ok(!('error' in settings))
  const slots = readSlots(settings as Record<string, string>)
  assert.equal(slots[0].command, 'CLAUDE_CONFIG_DIR=~/a claude')
  assert.equal(slots[1].enabled, false)
  // Only the first bar splits, so a command may contain pipes.
  assert.equal(slots[2].command, 'codex --profile home | tee x')
  assert.equal(formatSlotLines(slots), 'Work | CLAUDE_CONFIG_DIR=~/a claude\n\nHome | codex --profile home | tee x')
  assert.match(String((parseSlotLines('no bar here') as { error: string }).error), /Line 1 needs/)
  assert.match(String((parseSlotLines('Label |') as { error: string }).error), /no command/)
  assert.match(String((parseSlotLines(Array(13).fill('a | b').join('\n')) as { error: string }).error), /At most 12/)
})
