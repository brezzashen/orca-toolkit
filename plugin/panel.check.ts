// `orca plugin check` and `orca plugin shot --scenario` render the panel once per scenario, with
// the worker on a fresh host seeded with these settings.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {},
  demo: {
    settings: {
      'slot1.label': 'Work',
      'slot1.command': 'CLAUDE_CONFIG_DIR=~/.claude-work claude',
      'slot2.label': 'Personal',
      'slot2.command': 'claude',
      'slot3.label': 'Codex',
      'slot3.command': 'codex',
      'slot4.label': 'Team seat',
      'slot4.command': 'CLAUDE_CONFIG_DIR=~/.claude-team claude --chrome'
    }
  }
})
