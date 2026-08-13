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
    workflow: {
      description: 'Workflow management (init/run/export/import, DAG execution)',
    },
    plugin: {
      description: 'Plugin marketplace (install/search/list/remove/browse/recommend/popular)',
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
    provider: 'Provider',
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
    vscodeArgvOk: '{path} (disable-extension correct, {count} disabled)',
    vscodeArgvWarn: '{path} (present but no disable-extension configured)',
    vscodeArgvMissing: '{path} not found (no persistent disable config)',
    vscodeArgvIneffective:
      '⚠️ ineffective location: %APPDATA%\\Code\\argv.json exists but VS Code does not read it (actual: ~/.vscode/argv.json); delete or move it',
    vscodeArgvInvalidField:
      '❌ wrong field name: plural disable-extensions only accepts boolean (true = disable all); use singular disable-extension for an array — VS Code silently ignores mismatched types, disabling does not take effect',
    vscodeArgvInvalidValue: '❌ invalid value: disable-extension must be an array of strings',
    vscodeArgvPluralAll:
      '⚠️ disable-extensions: true = disable ALL extensions (to disable only specific ones, use singular disable-extension array)',
    vscodeArgvInvalidId:
      '❌ invalid extension ID quoting: must be JSON strings (wrapped in "); found unquoted/single-quoted/trailing comma',
    // v4.0 M3 T3.2: model recommendation block
    recommendLabel: 'Model recommendation',
    recommendLine: 'Recommend {provider}/{model} (monthly cost est. ¥{monthlyCost}) — {reason}',
    recommendReasonLowLocal: 'Low budget + local Ollama available; zero cost, offline-capable',
    recommendReasonLowCloud: 'Low budget + no local model; DeepSeek low-cost tier',
    recommendReasonMedium: 'Default combo; balanced cost/quality',
    recommendReasonHighLarge: 'Large project + high budget; prefer the strongest model',
    recommendReasonHighSmall: 'High budget + lightweight project; OpenAI value tier',
    recommendLocalUnavailable: 'Local Ollama probe failed (no local model recommended)',
    // v4.0 M3 T3.5: config migration integrity check
    migrationLabel: 'Config migration integrity',
    migrationOk: 'v4 migration complete (schema v2 + defaultProvider + providers)',
    migrationNotMigrated:
      'Config is still v3 format (schema v1); it will be auto-migrated at startup',
    migrationBackupOk: 'backup exists: {path}',
    migrationBackupMissing: 'backup missing (config.v3.bak not found)',
    migrationSessionOk:
      'session format compatible (v4 only adds fields; v3 sessions are not broken)',
    migrationIdempotentOk: 'idempotent (check is read-only; repeated runs have no side effects)',
  },
  reviewer: {
    // v4.0 M1 T1.6: autoFix copy (/review --fix, review-to-fix loop)
    autofixBatchSummary: 'autoFix batch repair of {count} suggestion(s) (class A)',
    autofixProgress: 'Repairing issue {fixed}/{total}…',
    fixResultTitle: '🔧 Fix Results',
    fixResultLine:
      '✅ {fixed} fixed / ⚠ {manual} need manual review / ❌ {rolledBack} auto-rolled back',
    fixItemFixed: '✅ {location} — {title}',
    fixItemRolledBack: '❌ {location} — {title} (auto-reverted: {reason})',
    fixItemManual: '⚠ {location} — {title} ({reason})',
    reasonVerifyFailed: 'verify failed after fix; auto-reverted',
    reasonManual: 'needs manual review',
  },
  workflow: {
    // v4.0 M2 T2.6: workflow copy (concertoai workflow + /workflow)
    usage: 'Usage: concertoai workflow <list|init|run|export|import|create>',
    listEmpty: 'No workflows installed yet',
    listHint:
      'Generate one with `concertoai workflow init <template>`, or import a file with `concertoai workflow import <file>`',
    listHeader: 'Installed workflows ({count})',
    initPrompt: 'Choose a workflow template:',
    initChoice: 'Enter a number or template name: ',
    initAborted: 'No template selected; cancelled',
    initUnknown: 'Unknown template: {name}',
    initDone: 'Workflow {name} generated → {file}',
    runMissing: 'Usage: concertoai workflow run <name>',
    runStart: '▶ Starting workflow {name} ({steps} steps)',
    runProgress: 'Running step {current}/{total}: {step}…',
    runOk: 'Workflow {name} completed successfully',
    runFailed: 'Workflow {name} failed (failed step: {step}, {skipped} skipped)',
    workflowNotFound:
      'Workflow not found: {name} (generate one with `workflow init` or import a file)',
    exportMissing: 'Usage: concertoai workflow export <name>',
    exportTitle: 'Workflow {name} definition:',
    importMissing: 'Usage: concertoai workflow import <file>',
    importDone: 'Workflow {name} imported → {file}',
    importFailed: 'Import failed: {error}',
    createMissing: 'Usage: concertoai workflow create "<natural-language description>"',
    createFailed: 'Generation failed; please write the YAML manually',
    createPreview: 'Generated workflow preview (y to save / other to cancel):',
    createConfirm: 'Save this workflow? (y/N): ',
    createDone: 'Workflow {name} saved → {file}',
    createAborted: 'Save cancelled',
    failureHeader: '⚠️ Workflow execution failed',
    failureStep: 'Step {step} failed: {error}',
    failureOptions: '[R]etry [S]kip [F]ix and retry [A]bort',
    failurePrompt: 'Choose (R/S/F/A): ',
    approveStep: '⏸ Step requires approval. Command: {command}',
    approvePrompt: 'Approve execution? (y/N): ',
    inferFound: 'Possible dependencies detected between steps:',
    inferPrompt: 'Add these depends edges? (y/N): ',
    inferSkipped: 'Dependency inference skipped (config unchanged)',
  },
  plugin: {
    // v4.0 M4 T4.1~T4.5: plugin marketplace copy (concertoai plugin + /plugin)
    usage: 'Usage: concertoai plugin <install|search|list|remove|browse|recommend|popular>',
    // Categories (browse display: icon + name)
    categoryTool: '🔧 Tools',
    categoryWorkflow: '📋 Workflows',
    categoryAgent: '🤖 Agents',
    // install
    installMissing: 'Usage: concertoai plugin install <name>',
    installSearching: '🔍 Matching registry for: {name}…',
    installStart: '📦 Installing {name}@{version}…',
    installOk:
      '✅ Plugin {name}@{version} installed → {dir}\n\nRun /plugin list in chat to view, or follow the plugin docs.',
    installUpdated: '✅ Plugin {name} updated to {version} → {dir}',
    installFailed: '❌ Plugin install failed: {message}',
    installCanceled: 'Install of {name} cancelled (permission not approved; nothing was written).',
    installAlready: '📦 {message}',
    // Permission list (T4.2: colored icons at a glance)
    permissionTitle: '🔐 Permissions (verified at runtime; undeclared permissions are rejected):',
    permissionConfirm: 'Install? (y/N): ',
    permissionEmpty: '(no permissions declared — read-only mode; sensitive operations rejected)',
    // search
    searchMissing: 'Usage: concertoai plugin search <keyword>',
    searchTitle: '🔍 Plugin marketplace ({count}):',
    searchEmpty: 'No plugins match "{keyword}".',
    searchHint: '\n\nInstall with `concertoai plugin install <name>`.',
    searchInstalled: ' [installed {version}]',
    // list
    listEmpty: 'No plugins installed yet.',
    listHint:
      'Browse the marketplace with `concertoai plugin browse`, or install with `concertoai plugin install <name>`.',
    listHeader: 'Installed plugins ({count}):',
    // remove
    removeMissing: 'Usage: concertoai plugin remove <name>',
    removeOk: '✅ Plugin {name} removed.',
    removeNotFound: '❌ Plugin {name} is not installed (cannot remove).',
    // browse (T4.1a: category browse with downloads + rating)
    browseMissing: 'Usage: concertoai plugin browse [category] (category: tool / workflow / agent)',
    browseHeader: '📚 Plugin marketplace ({category}, {count}):',
    browseAll: 'All',
    browseLine: '- **{name}** {version} — {description} (⬇ {downloads} ⭐ {rating})',
    browseEmpty: 'No plugins in this category.',
    // recommend (T4.1a: project-feature heuristics)
    recommendHeader: '💡 Detected project traits; recommended for you:',
    recommendReasonExpress:
      'Express detected → recommend api-docs (auto-scan routes to generate API docs)',
    recommendReasonTodo:
      'TODO/FIXME markers detected → recommend todo-tracker (track tasks into a list)',
    recommendReasonRelease:
      'package.json detected → recommend release-helper (version check → gates → release)',
    recommendReasonGit:
      'git repo detected → recommend git-status (one-shot branch/staged/untracked summary)',
    recommendEmpty:
      'No clear project traits detected; try `concertoai plugin browse` to browse all plugins.',
    // popular (T4.1a: Top 10)
    popularHeader: '🔥 Community hot plugins Top {count}:',
  },
  provider: {
    // v4.0 M3 T3.1/T3.2b: provider management copy
    listTitle: 'Available providers:',
    statusOk: 'available',
    statusDegraded: 'degraded',
    statusUnavailable: 'unavailable',
    defaultLabel: 'default',
    ollamaLocalHint: 'Local model (Ollama) — zero cost, offline-capable',
    switchHint:
      'Switch: `concertoai provider switch <name>` or `concertoai --provider <name>` (temporary)',
    switchUnknown: 'Unknown provider: {name} (configure providers.{name} first)',
    switchDone: 'Default provider switched → {name}',
    authUnknown: 'Unknown provider: {name} (only deepseek / openai supported)',
    authPrompt: 'Enter {name} API Key (hidden):',
    authNoTty: 'Non-interactive terminal cannot hide input; use --key <key> instead',
    authEmpty: 'API Key must not be empty',
    authFailed: '❌ Key verification failed: ',
    authOk: '✅ Key verified',
    authVerifyOnly: '(--verify only; not saved)',
    authSaved: '✅ {name} API Key saved to accounts/ (0600) and set active',
    authSaveFailed: '❌ Save failed: ',
    // T3.4 fallback + T3.2a cost hints (status bar)
    fallbackNote: 'Primary model {primary} unavailable; switched to {fallback} (reason: {reason})',
    costCompare: 'Switched to {current}; estimated cost is about {ratio}x of {baseline}',
    costCompareLocal: 'Using a local model (Ollama) — zero cost, offline-capable',
    sessionCostCompare:
      'This session cost ¥{actual} ({current}); with {baseline} it would be about ¥{estimate}',
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
    // repair.ts debug logs (v4.0 M1 T1.6: I4 carry-over, localized logs)
    logLintFixAttempt:
      '[self-heal] attempt {attempt}: running npm run lint:fix ({count} lint error(s))',
    logLintFixFailed:
      '[self-heal] lint:fix failed; remaining type errors skipped (environment issue), hand off to human',
    logModelFixAttempt:
      '[self-heal] attempt {attempt}: model-fixing type error {code} @ {file}:{line}',
    logRemainingManual: '[self-heal] remaining errors are not auto-fixable; hand off to human',
  },
  team: {
    // v4.0 M5: parallel multi-agent execution (team --parallel)
    parallel: {
      taskPrefix: 'task {taskId} ',
      taskDone: '⚡ task {taskId} finished in parallel',
      taskFailed: '❌ task {taskId} failed in parallel',
      fallbackSerial: 'Cannot split into parallel tasks; executing sequentially',
      conflict: '⚠️ {taskA} and {taskB} both modified {file}; please choose which version to keep',
      summaryOk: '✅ all {count} tasks completed',
      summaryPartial: '⚠️ {ok} done / {failed} failed ({failedIds})',
    },
  },
  ui: {
    thinking: 'Thinking',
    toolRunning: 'Running tool: {name}',
    toolDone: 'Tool finished: {name}',
    quit: 'Exited. Session saved.',
  },
} as const;

export type EnDict = typeof en;
