// Sidebar panel: every configured slot as a row that opens it, and one text box that edits all
// twelve. A click and a keyboard shortcut use the same worker request path.
import {
  atom,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Heading,
  List,
  ListItem,
  plugin,
  read,
  set,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import { formatSlotLines, type Slot } from './slots'

/** Slots as the worker last reported them; null until it answers. */
const slots = atom<Slot[] | null>(null)
/** What the last press did, shown under the list. */
const outcome = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
/** The edit box; null means "show the saved slots". */
const draft = atom<string | null>(null)

function failure(error: unknown): { tone: 'danger'; text: string } {
  return { tone: 'danger', text: error instanceof Error ? error.message : String(error) }
}

async function refresh(): Promise<void> {
  const answer = await plugin.request('slots.list')
  set(slots, answer.slots)
}

async function openSlot(slot: Slot): Promise<void> {
  try {
    const opened = await plugin.request('slots.open', { index: slot.index })
    set(outcome, { tone: 'success', text: `Opened ${opened.title}.` })
  } catch (error) {
    set(outcome, failure(error))
  }
}

async function save(text: string): Promise<void> {
  try {
    const answer = await plugin.request('slots.import', { text })
    set(slots, answer.slots)
    set(draft, null)
    set(outcome, { tone: 'success', text: 'Slots saved.' })
  } catch (error) {
    set(outcome, failure(error))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('slots.changed', () => void refresh()))
  void refresh()
}

function Editor({ all }: { all: Slot[] }) {
  const text = read(draft) ?? formatSlotLines(all)
  return (
    <Collapsible title="Edit all slots" description="One line per slot: label | command">
      <Stack gap="sm">
        <Textarea
          label="Slots"
          labelHidden
          rows={12}
          value={text}
          placeholder={'Work | CLAUDE_CONFIG_DIR=~/.claude-work claude\nPersonal | claude'}
          onChange={(value) => set(draft, value)}
        />
        <Button icon="check" onPress={() => save(text)}>
          Save slots
        </Button>
      </Stack>
    </Collapsible>
  )
}

export default function Panel() {
  const all = read(slots)
  const last = read(outcome)
  if (all === null) return <Text muted>Loading slots…</Text>
  const enabled = all.filter((slot) => slot.enabled)
  return (
    <Stack gap="md">
      {enabled.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="No account slots yet"
          description="Add one line per slot below, or set each slot in Settings > Plugins > Orca Toolkit."
        />
      ) : (
        <Stack gap="sm">
          <Heading level={3}>Account slots</Heading>
          <List label="Account slots">
            {enabled.map((slot) => (
              <ListItem
                title={slot.label}
                description={`${slot.shortcut} · ${slot.command}`}
                icon="terminal"
                onPress={() => openSlot(slot)}
              />
            ))}
          </List>
        </Stack>
      )}
      {last ? <Callout tone={last.tone}>{last.text}</Callout> : null}
      <Editor all={all} />
      <Text muted size="xs">
        Opens in the background. Paired desktop workspaces may be unavailable.
      </Text>
    </Stack>
  )
}
