/**
 * English dictionary. Mirrors the structure of zh.ts — keys must stay in sync
 * (en.test.ts asserts structural equality).
 */

import { MAX_LOOP_TURNS } from '../loop/loop';

export const en = {
  cli: {
    description: 'ConcertoAI — a Chinese-first terminal coding assistant for individual developers',
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
    balance: {
      description: 'Query DeepSeek account balance',
    },
    doctor: {
      description: 'Environment diagnostics (includes DeepSeek account balance)',
    },
  },
  errors: {
    noApiKey: 'DEEPSEEK_API_KEY not found. Set it first, then start again.',
    noTty:
      'chat mode requires an interactive terminal. Run `concertoai chat` directly (not via a pipe/script), or use `concertoai run "<task>"` instead.',
    modelCallFailed: 'Model call failed: {message}',
    get loopMaxTurns() {
      return `Tool call limit reached (${MAX_LOOP_TURNS} turns). Progress saved — continue typing to let the assistant resume.`;
    },
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
    confirm: 'Approve (y / Enter)',
    reject: 'Reject (n / Esc)',
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
    hint: 'Approve (y / Enter) / Reject (n / Esc)',
    approved: 'Plan approved; starting execution',
    rejected: 'Plan rejected; nothing was executed',
  },
  balance: {
    available: 'Account available',
    unavailable: 'Account unavailable',
    empty: 'No balance info',
    line: '💰 Balance: {symbol}{total}',
  },
  peakTime: {
    askSwitch:
      'It is currently peak time (workdays 9-12 / 14-18). Switch to local model {model} ({baseUrl}) to save API costs?',
    switched: 'Switched to local model {model} ({baseUrl})',
    declined: 'Keeping primary model {model}',
    ignored: 'Peak-time switching is configured as ignore; keeping primary model {model}',
    noInteractive:
      'Non-interactive environment; skipping peak-time switch, keeping primary model {model}',
  },
  doctor: {
    title: 'ConcertoAI environment diagnostics',
    ok: '✅',
    fail: '❌',
    money: '💰',
    nodeLabel: 'Node.js',
    platformLabel: 'Platform',
    apiKeyLabel: 'API Key',
    apiKeySet: 'set',
    apiKeyMissing: 'not set (cannot query balance)',
    configLabel: 'Config file',
    configOk: '{path} (readable, schema v{version})',
    configMissing: '{path} (missing, using defaults)',
    configBroken: '{path} (read failed: {message})',
    sessionDirLabel: 'Session dir',
    sessionWritable: '{path} (writable)',
    sessionNotWritable: '{path} (not writable: {message})',
    modelsLabel: 'Model table',
    modelsCount: '{count} models ({ids})',
    modelsEmpty: 'Model table is empty',
    accountsLabel: 'Accounts',
    accountNoActive: 'no active account (run `concertoai login <name>` to log in)',
    accountOk: 'active: {name} (account complete)',
    accountBroken: 'active: {name} (account config missing; run `concertoai login {name}`)',
    balanceLabel: 'Account balance',
    balanceAvailable: 'Account available',
    balanceUnavailable: 'Account unavailable',
    balanceSkipped: 'not queried (missing DEEPSEEK_API_KEY)',
    balanceFailed: 'query failed: {message}',
    balanceEntry: '{currency}: total {total} | granted {granted} | topped-up {toppedUp}',
  },
  selfHeal: {
    // Phase labels (v3.3 S1: selfHealPhaseLabel moved into i18n)
    phaseVerify: 'Running verify',
    phaseLintFix: 'Lint fix',
    phaseModelFix: 'Model fix',
    phaseVerifyFix: 'Post-fix verify',
    phaseRollback: 'Rollback',
    phaseDone: 'Done',
    // Attempt action labels (v3.3 S1: actionLabel moved into i18n)
    actionLintFix: 'lint direct fix',
    actionModelFix: 'model fix',
    actionSkip: 'skipped',
    // Report copy (formatSelfHealReport)
    verifyPassedNoFix: '✅ verify passed, no fix needed',
    repairedPassed: '✅ self-heal repaired: verify passed',
    exceeded: '❌ Fix attempts exhausted; please handle manually',
    verifyFailed: '❌ verify failed; please handle manually',
    repairProcessTitle: '### Repair process',
    attemptLine: '{n}. Attempt #{attempt}: {action}{fixes} {outcome}',
    unknownReason: 'unknown reason',
    rolledBack: '→ ❌ rolled back ({reason})',
    notFixed: '→ ⏭ not fixed ({suggestion})',
    skipped: '→ ⏭ skipped',
    verifyPassed: '→ ✅ verify passed',
    keepGoing: '→ 🔁 continuing (errors remain)',
    remainingTitle: '### Remaining errors ({count}, manual)',
    snapshotCommitted: 'Snapshot committed; no residue.',
    snapshotProtection:
      '⚠️ Snapshot protection enabled: ineffective fixes were rolled back; leftover snapshots can be viewed with `concertoai snapshot list`.',
    snapshotWarning:
      '⚠️ Snapshot protection inactive: snapshot registration failed for this model fix, automatic rollback unavailable (please review changes manually).',
  },
  ui: {
    thinking: 'Thinking',
    toolRunning: 'Running tool: {name}',
    toolDone: 'Tool finished: {name}',
    quit: 'Exited. Session saved.',
  },
} as const;

export type EnDict = typeof en;
