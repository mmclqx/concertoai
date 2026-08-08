/**
 * English dictionary. Mirrors the structure of zh.ts — keys must stay in sync
 * (en.test.ts asserts structural equality).
 */

export const en = {
  cli: {
    description: 'Lumen — a Chinese-first terminal coding assistant for individual developers',
    chat: {
      description: 'Start an interactive conversation',
    },
    run: {
      description: 'Run a one-shot task',
      argument: 'Task description',
    },
    resume: {
      description: 'Resume a previous session',
      argument: 'Session ID (omit to pick from a list)',
    },
    list: {
      description: 'List historical sessions only, without entering a conversation',
    },
    plan: {
      description: 'Generate an execution plan first, then execute after approval',
    },
    model: {
      description: 'Model ID (default: deepseek-v4-flash)',
    },
  },
  errors: {
    noApiKey: 'DEEPSEEK_API_KEY not found. Set it first, then start again.',
    noTty:
      'chat mode requires an interactive terminal. Run `lumen chat` directly (not via a pipe/script), or use `lumen run "<task>"` instead.',
    modelCallFailed: 'Model call failed: {message}',
    loopMaxTurns:
      'Tool call limit reached (10 turns). Progress saved — continue typing to let the assistant resume.',
    streamAborted: 'Generation interrupted; generated content was kept. You can continue typing.',
    streamInterrupted: 'Network interrupted: {message}. Generated content was kept; please retry.',
    planNeedsTty:
      'plan mode requires an interactive terminal to approve the plan (or use --auto-approve)',
    unknownTool: 'Unknown tool: {name}',
    invalidSessionId: 'Invalid session id: {id}',
    sessionNotFound: 'Session not found: {id}',
    projectRulesReadFailed: 'Failed to read project rules',
  },
  approval: {
    editTitle: 'Edit file',
    shellTitle: 'Run command',
    summaryEdit: 'Edit file {path}',
    summaryShell: 'Run command: {command}',
    confirm: 'Approve (y)',
    reject: 'Reject (n)',
  },
  prompt: {
    placeholder: 'Type your request… (Enter to send / Shift+Enter for newline / Esc to quit)',
  },
  status: {
    model: 'Model',
    tokens: 'token',
    cost: 'Cost',
    yuan: '¥',
    real: 'actual',
    cacheHit: 'Cache hit',
  },
  session: {
    resumed: 'Resumed session {id} ({count} messages)',
    newSession: 'New session',
    listTitle: 'Historical sessions (newest first)',
    empty: 'No sessions yet',
    saved: 'Session saved: {id}',
    pickerHint: '↑/↓ to select, Enter to confirm, Esc to cancel',
    noUserMessage: '(no user message)',
  },
  plan: {
    title: 'Execution Plan',
    hint: 'Approve plan (y) / Reject (n)',
    approved: 'Plan approved; starting execution',
    rejected: 'Plan rejected; nothing was executed',
  },
  ui: {
    thinking: 'Thinking',
    toolRunning: 'Running tool: {name}',
    toolDone: 'Tool finished: {name}',
    quit: 'Exited. Session saved.',
  },
} as const;

export type EnDict = typeof en;
