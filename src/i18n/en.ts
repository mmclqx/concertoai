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
    // VS Code health diagnostics (v3.4 M3 / doctor --vscode)
    vscodeTitle: 'VS Code health diagnostics',
    vscodeProcessLabel: 'Code processes',
    vscodeProcessOk: '{count} (normal)',
    vscodeProcessWarn: '{count} (elevated; close extra windows and merge workspaces)',
    vscodeProcessFail:
      '{count} (critical; likely multi-window x AI extensions blow-up, close extra windows now)',
    vscodeProcessUnavailable: 'unable to detect (command failed or timed out)',
    vscodeDumpLabel: 'Crash dumps',
    vscodeDumpOk: 'no backlog (0)',
    vscodeDumpWarn: '{count} / {size} (cleanup recommended)',
    vscodeDumpFail: '{count} / {size} (severe backlog, clean up)',
    vscodeDumpCleanCmd: 'cleanup command: {command}',
    vscodeAiExtLabel: 'AI extensions',
    vscodeAiExtOk: '{count} (<=3, normal)',
    vscodeAiExtWarn: '{count} (>3, redundant AI extensions; disable or uninstall)',
    vscodeAiExtUnavailable: 'unable to detect (code CLI not in PATH)',
    vscodeAiExtNotDisabled: 'installed but not disabled: {ids}',
    vscodeAiExtSuggest: 'suggestion: {command} or write to argv.json',
    vscodeArgvLabel: 'argv.json',
    vscodeArgvOk: '{path} (disable-extensions correct, {count} disabled)',
    vscodeArgvWarn: '{path} (present but no disable-extensions configured)',
    vscodeArgvMissing: '{path} not found (no persistent disable config)',
    vscodeArgvIneffective:
      '⚠️ ineffective location: %APPDATA%\\Code\\argv.json exists but VS Code does not read it (actual: ~/.vscode/argv.json); delete or move it',
    vscodeArgvInvalidField:
      '❌ wrong field name: use disable-extensions (plural); found disable-extension (singular) — VS Code ignores it, disabling does not take effect',
    vscodeArgvInvalidValue: '❌ invalid value: disable-extensions must be an array or true',
    vscodeArgvInvalidId:
      '❌ invalid extension ID quoting: must be JSON strings (wrapped in "); found unquoted/single-quoted/trailing comma',
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
    // feedback data layer (v3.4 T1.4 I1: suggestion copy via i18n so --lang en reports stay all-English)
    feedbackBuildFailed:
      'Build failed: check the tsup.config.ts entry, missing dependencies, or export syntax',
    feedbackTestFailed:
      'Test failed: check the test assertions or the tested module implementation (self-heal does not auto-fix tests)',
    feedbackTypeError:
      'Type error ({code}): add type annotations or adjust the types manually (self-heal only auto-fixes missing imports / missing annotations)',
    feedbackFormatError: 'Format error: run `npm run lint:fix` to auto-fix',
    feedbackUnknown: 'Unknown error: please check manually',
    feedbackDenied: 'User rejected the auto-fix; please handle manually',
    feedbackWriteFailedRolledBack: 'Fix write failed; rolled back. Please handle manually',
    feedbackWriteFailed: 'Fix write failed; please handle manually',
  },
  ui: {
    thinking: 'Thinking',
    toolRunning: 'Running tool: {name}',
    toolDone: 'Tool finished: {name}',
    quit: 'Exited. Session saved.',
  },
} as const;

export type EnDict = typeof en;
