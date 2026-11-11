// `orca plugin test .` runs this in Node with the runtime and checks Orca uses.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { readSlots } from './slots'

test('lists the configured slots and reports what a press did', async () => {
  const slots = readSlots({ 'slot1.label': 'Work', 'slot1.command': 'claude', 'slot2.label': 'Home', 'slot2.command': 'codex' })
  const host = mockHost({
    requests: {
      'slots.list': () => ({ slots }),
      'slots.open': ({ index }) => {
        if (index === 2) throw hostError('action_failed', 'No workspace is focused. Open a workspace first.')
        return { terminalId: 'term-1', title: 'Work' }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.match(JSON.stringify(view.tree()), /"title":"Work"/)
  assert.match(JSON.stringify(view.tree()), /Alt\+F2 · codex/)
  await view.press({ label: 'Work' })
  assert.ok(view.find({ text: 'Opened Work.' }))
  await view.press({ label: 'Home' })
  assert.ok(view.find({ text: 'No workspace is focused. Open a workspace first.' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows how to start when no slot has a command', async () => {
  const host = mockHost({ requests: { 'slots.list': () => ({ slots: readSlots({}) }) } })
  const view = await mount(panel, { host })
  assert.match(JSON.stringify(view.tree()), /No account slots yet/)
  await view.unmount()
})

test('saves every slot from the edit box', async () => {
  let saved = ''
  const host = mockHost({
    requests: {
      'slots.list': () => ({ slots: readSlots({}) }),
      'slots.import': ({ text }) => {
        saved = text
        return { slots: readSlots({ 'slot1.label': 'Work', 'slot1.command': 'claude' }) }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.toggle({ label: 'Edit all slots' })
  await view.type({ label: 'Slots' }, 'Work | claude', { replace: true })
  await view.press({ text: 'Save slots' })
  assert.equal(saved, 'Work | claude')
  assert.ok(view.find({ text: 'Slots saved.' }))
  assert.match(JSON.stringify(view.tree()), /"title":"Work"/)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
