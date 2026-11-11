// Runs plugin/worker.ts's activate(orca) over a mock host: shortcut commands, panel requests, errors.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const capabilities = ['workspace:read', 'workspace:write', 'terminal:send', 'agent:read', 'settings:own', 'notifications:show']
const commands = [...Array.from({ length: 12 }, (_, i) => `slot-${i + 1}`), 'show']

function host(settings: Record<string, string>) {
  return mockHost({
    capabilities,
    settings,
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'app', terminals: [{ id: 't-1' }] },
      'workspace.list': {
        workspaces: [{ id: 'w-app', kind: 'worktree', name: 'app', path: '/plugin/app', branch: 'main', hostId: null }],
        truncated: false
      },
      'terminal.create': { terminalId: 'term-new' },
      'notifications.show': { delivered: true },
      'workspace.open': { opened: true }
    }
  })
}

test('Alt+F2 opens slot 2 in the focused workspace with its command and label', async () => {
  const mock = host({ 'slot2.label': 'Work', 'slot2.command': 'CLAUDE_CONFIG_DIR=~/.claude-work claude' })
  const worker = await mountWorker(main, { host: mock, commands, events: ['agent.status.changed'] })
  assert.equal(await worker.command('slot-2'), 'Opened Work')
  assert.deepEqual(mock.callsOf('terminal.create'), [
    { workspaceId: 'w-app', title: 'Work', command: 'CLAUDE_CONFIG_DIR=~/.claude-work claude' }
  ])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an empty slot creates nothing and says why', async () => {
  const mock = host({})
  const worker = await mountWorker(main, { host: mock, commands, events: ['agent.status.changed'] })
  assert.match(String(await worker.command('slot-5')), /Slot 5 has no command yet/)
  assert.equal(mock.callsOf('terminal.create').length, 0)
  assert.equal(mock.callsOf('notifications.show').length, 1)
  await worker.deactivate()
})

test('the panel lists slots and opens one', async () => {
  const mock = host({ 'slot1.label': 'Personal', 'slot1.command': 'codex' })
  const worker = await mountWorker(main, { host: mock, commands, events: ['agent.status.changed'] })
  const listed = await worker.request('slots.list')
  assert.equal(listed.slots.filter((slot) => slot.enabled).length, 1)
  assert.deepEqual(await worker.request('slots.open', { index: 1 }), { terminalId: 'term-new', title: 'Personal' })
  assert.match(String(await worker.command('show')), /Alt\+F1 {2}Personal/)
  await worker.deactivate()
})

test('import writes all twelve slots to settings', async () => {
  const mock = host({ 'slot3.label': 'Old', 'slot3.command': 'old' })
  const worker = await mountWorker(main, { host: mock, commands, events: ['agent.status.changed'] })
  const answer = await worker.request('slots.import', { text: 'Work | claude' })
  assert.deepEqual(answer.slots.filter((slot) => slot.enabled).map((slot) => slot.label), ['Work'])
  const settings = mock.data().settings as Record<string, string>
  assert.equal(settings['slot1.command'], 'claude')
  assert.equal(settings['slot3.command'], '')
  await assert.rejects(worker.request('slots.import', { text: 'oops' }), /Line 1 needs/)
  await worker.deactivate()
})

test('a new slot terminal is shown as a tab by opening its workspace', async () => {
  const mock = host({ 'slot1.label': 'Work', 'slot1.command': 'claude' })
  const worker = await mountWorker(main, { host: mock, commands, events: ['agent.status.changed'] })
  await worker.command('slot-1')
  assert.deepEqual(mock.callsOf('workspace.open'), [{ workspaceId: 'w-app' }])
  await worker.deactivate()
})
