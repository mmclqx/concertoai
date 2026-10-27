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
    update: {
      description: 'Check for updates and upgrade (--yes skips confirmation)',
      yes: 'Skip confirmation and upgrade',
    },
    init: {
      description:
        'Analyze the project and generate two guides (AGENTS.md for AI + PROJECT_GUIDE.md for humans)',
      force: 'Overwrite existing files (default: never overwrite, ask interactively)',
    },
    doctor: {
      description: 'Environment diagnostics (includes DeepSeek account balance)',
    },
    workflow: {
      description: 'Workflow management (init/run/export/import, DAG execution)',
    },
    lsp: {
      description: 'Start Language Server (--stdio: diagnose on save + one-click CodeAction fix)',
      stdioRequired: 'lsp command requires --stdio (only stdio transport is supported)',
    },
    plugin: {
      description: 'Plugin marketplace (install/search/list/remove/browse/recommend/popular)',
    },
    reflect: {
      description: 'Rejection retrospectives (list / clear; local JSONL, never uploaded)',
      limit: 'Number of entries to show (default 20)',
      yes: 'Skip the confirmation prompt (required in non-interactive environments)',
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
    // v4.1 T2.1: next-step guidance for unknown exceptions (safeAction fallback)
    fatalNextStep:
      '💡 Next: run `concertoai doctor` to check the environment; if it is a software defect, report the error above.',
  },
  // v5.0 T1: missing API key guide (command snippets live in src/cli/api-key-guide.ts)
  missingApiKey: {
    title: '⚠️  DeepSeek API key not found — ConcertoAI needs it to call the model',
    intro: 'Pick one way to configure it (option 1 is recommended and takes effect immediately):',
    envTitle: '1. Set an environment variable',
    accountTitle: '2. Log in an account (stored locally; no need to repeat later)',
    accountHint: '(interactive input is hidden: concertoai login myname)',
    configTitle: '3. Write the config file (create the directory first if missing)',
    getKeyLabel: 'Get an API key:',
    nextStep: '💡 After configuring, run `concertoai doctor` to verify the environment.',
  },
  // v5.0 T5: init command (dual output)
  init: {
    scanning: '🔍 Analyzing project (package.json / sources / config / TODO)…',
    truncated: '⚠️  Reached scan limit of {count} files; results may be incomplete',
    skippedFiles: 'ℹ️  Skipped {count} files (too large or unreadable)',
    overwritePrompt: '{file} already exists. Overwrite? [y/N] ',
    existsNonTty:
      'ℹ️  {file} already exists; non-interactive environment will not overwrite (use --force)',
    writeFailed: '❌ Failed to write {file}: {error}',
    nothingWritten: 'No files written (existing files kept). Use --force to regenerate.',
    partiallySkipped: 'ℹ️  Skipped (kept original): {files}',
    notAProject:
      '⚠️  This directory does not look like a project root (no package.json / src / pyproject.toml / Cargo.toml / go.mod)',
    notAProjectHint:
      '💡 Run `concertoai init` in the project root; no empty files will be created.',
  },
  // v5.0 T2: update command
  update: {
    checking: '🔍 Checking for updates (current {current})…',
    upToDate: '✅ Already up to date ({current}).',
    newVersion: '📦 New version available: {current} → {latest}',
    npxHint:
      '⚠️  Running via npx (not globally installed); upgrading a temp install is pointless.\n💡 Install globally first: {command}',
    needConfirmNonTty:
      'Note: non-interactive environment never auto-upgrades. To upgrade run: {command}',
    confirmPrompt: 'Upgrade to {latest}?',
    cancelled: 'Cancelled, nothing changed.',
    installing: '⏳ Installing {latest} …',
    installOk: '✅ Upgraded to {latest}. Re-run concertoai to take effect.',
    installFailed: '❌ Install failed: {error}',
    fetchFailed: '❌ Update check failed: {error}',
    manualHint: '💡 Manual upgrade: {command}',
  },
  // v5.0 T1: Node version notice (engines requires >= 22; non-blocking, TTY only)
  nodeVersion: {
    tooOld:
      '⚠️  Current Node {current}, ConcertoAI requires {required}. This command will still run, but some features may misbehave; upgrade Node if you hit issues.',
  },
  approval: {
    editTitle: 'Edit file',
    shellTitle: 'Run command',
    // v5.0 T6: model switch approval (higher cost confirmation)
    modelTitle: 'Switch model (cost increases)',
    summaryEdit: 'Edit file {path}',
    summaryShell: 'Run command: {command}',
    confirm: 'Approve (y / Enter)',
    reject: 'Reject (n / Esc)',
    // ── v5.0 T9: risk teaching card (rich path). The 6 keys above are plain-path only
    //    (v4.1.1 look); both paths share src/ui/approval-text.ts renderers.
    // Wording red line: never use alarmist words here — medium rules are noisy by nature
    // (see ADR-040 known limits + ADR-041).
    levelTitle: {
      high: '⚠️ High-risk approval',
      medium: '🟡 Medium-risk approval',
      low: '✅ Low-risk approval',
    },
    action: {
      edit: 'edit',
      shell: 'run command',
      model: 'switch model',
    },
    intentLabel: 'Intent: ',
    intent: {
      create: 'create new file',
      modify: 'partial edit (SEARCH/REPLACE)',
    },
    natureLabel: 'What changes: ',
    noRiskPattern: '✅ No known risk pattern matched ({count} rule groups checked)',
    riskLabel: 'Risk points:',
    attentionLabel: '🟡 Worth a closer look (medium-risk hint, non-blocking):',
    focusLabel: '💡 Focus here: line {line} ({why})',
    impactLabel: 'Blast radius: ',
    impactOk: 'referenced by {count} file(s) ({paths})',
    impactOkZero: 'no other file references it ({scanned} files scanned)',
    impactSkippedFiles: ', {count} unreadable file(s) skipped',
    // Wording red line: "not analyzed" is not "no impact".
    impactTimeout: 'not analyzed (timed out after {ms}ms)',
    impactSkipped: 'not analyzed (project too large, more than {maxFiles} files)',
    impactError: 'not analyzed (read failed)',
    // Fifth state (T11): low risk → no scan. Say "not scanned", never "too large"/"no impact".
    impactNotNeeded: 'low-risk change — blast radius not scanned (only medium/high are scanned)',
    impactNotApplicable: 'not applicable (this action has no file references)',
    hugeDiff: '{count} changed lines — risk analysis skipped (huge diff)',
    diffFold: '… {count} more lines hidden, press v for the full diff',
    diffTruncated: '… diff truncated ({total} lines total, first {limit} shown)',
    diffFocusMark: ' ⚠️',
    keyApprove: '[y] approve',
    keyReject: '[n] reject (AI will try a more conservative approach)',
    keyExpand: '[v] full diff',
    keyCollapse: '[v] collapse diff',
    keyHelp: '[?] help',
    keyHelpClose: '[?] close help',
    helpTitle: 'What this screen tells you',
    helpHigh:
      '⚠️ High: a high-risk rule matched (delete/overwrite/auth/secret/path) — read line by line.',
    helpMedium:
      '🟡 Medium: a noisy rule matched (timeout/assertion/dependency) — a hint to look closer, not a verdict.',
    helpLow:
      '✅ Low: no known rule matched; the rule table is finite, so this is not a safety proof.',
    helpSource:
      'Rules: built-in local table ({count} groups), no model calls, no network, code never leaves your machine.',
    helpDisable: 'To turn it off: config.approvalInsight = "plain" (restores the v4.1.1 view).',
    helpKeys: 'Keys: [y] approve · [n] reject · [v] toggle full diff · [?] close this help',
  },
  prompt: {
    placeholder: 'Type your request… (Enter to send / Shift+Enter for newline / Esc to quit)',
    // v5.0 T13: the input box stays live while awaiting a reply (otherwise
    // /hints off cannot be typed at all when offline); a plain request submitted
    // at that moment is ignored — say so instead of silently swallowing it.
    busyWaiting: '⏳ Waiting for the model… (Ctrl+C to interrupt; /hints off mutes hints)',
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
    // v5.0 T9: plan progress view text (was hardcoded in modals.tsx; moved to i18n
    // so the "no user-facing literals inside Ink components" guard can be strict)
    progressTitle: 'Progress {done}/{total}',
    progressFailedSuffix: ' ({failed} failed)',
    progressStep: 'Step {index}. {title}',
  },
  // v5.0 T10: rejection retrospectives (local JSONL, never uploaded)
  reflect: {
    listTitle: 'Rejection retrospectives ({count} entries, newest first)',
    listEmpty:
      'No retrospectives yet. Rejecting an edit records one automatically (local JSONL only, never uploaded).',
    listSkipped: '⚠️ Skipped {count} corrupted line(s) (manual edit or interrupted write)',
    listHint: 'Clear: concertoai reflect clear　·　Disable: concertoai config set reflections off',
    colTime: 'Time',
    colLevel: 'Level',
    colFile: 'File',
    colCategories: 'Risk categories',
    levelHigh: '⚠️ High',
    levelMedium: '🟡 Med',
    levelLow: '✅ Low',
    // "not analyzed" is not "low risk" (same wording red line as the approval card)
    levelUnknown: '— n/a',
    noFile: '—',
    noCategories: '—',
    clearConfirm: 'Clear all retrospectives? (y/N)',
    clearCanceled: 'Canceled; retrospectives unchanged.',
    clearEmpty: 'There is nothing to clear.',
    clearNeedsYes:
      '❌ Non-interactive environment requires --yes to clear (prevents scripts from wiping history).',
    cleared: '✅ Retrospectives cleared: {path}',
    clearFailed: '❌ Clear failed: {message}',
    unknownAction: 'Unknown reflect subcommand: {action} (supported: list / clear)',
    usage: 'Usage: concertoai reflect list [--limit 20] | concertoai reflect clear [--yes]',
    limitInvalid: '⚠️ --limit must be a positive integer; using the default of {limit}',
    recorded:
      '📝 Recorded to local retrospectives (see concertoai reflect list; disable with concertoai config set reflections off)',
    recordFailed: '📝 Failed to record the retrospective (ignored; approval result unaffected)',
  },
  // v5.0 T12: scenario hints (M3). Rendered as one dim line above the prompt:
  // never a modal, never in the message stream, never interrupting streaming.
  hints: {
    missingProjectRules:
      '💡 This project has no rules file yet; concertoai init generates AGENTS.md (for the AI) + PROJECT_GUIDE.md (for you)',
    repeatedVerifyFailure:
      '💡 Build or tests failed 2 turns in a row; let the AI locate and fix it automatically (rolls back on failure)',
    // {file} is filled in by the engine; when the path contains spaces the engine falls back to the next message
    repeatedEditRejection:
      '💡 You rejected changes to {file} twice in a row; let the Reviewer Agent scan it before retrying',
    // Fallback when no usable file path is available (pairs with `/review` auto mode, no placeholder)
    repeatedEditRejectionNoFile:
      '💡 You rejected AI changes twice in a row; let the Reviewer Agent scan recently modified files before retrying',
  },
  // v5.0 T13: `/hints` slash command (session mute / restore / status)
  hintsCmd: {
    off: '🔇 Scenario hints disabled (this session only). Restore: /hints on　·　Permanent: concertoai config set hints off',
    on: '💡 Scenario hints enabled (strictly limited: at most 3 per session, same one not repeated within 10 minutes)',
    statusOn:
      '💡 Scenario hints: enabled (at most {max} per session; the same one not repeated within {minutes} minutes)',
    statusOff: '🔇 Scenario hints: disabled (restore with /hints on)',
    usage: 'Usage: /hints on | /hints off | /hints status',
    unknownAction: 'Unknown hints subcommand: {action} (supported: on / off / status)',
  },
  balance: {
    available: 'Account available',
    unavailable: 'Account unavailable',
    empty: 'No balance info',
    line: '💰 Balance: {symbol}{total}',
    // v5.0 T7: current-tier real price (peak / off-peak label)
    priceTier:
      '📊 Current {model} {tier}: input ¥{input}/M · cache hit ¥{cacheHit}/M · output ¥{output}/M',
    // v5.0 T7 revision: honest notice when the statutory-holiday calendar is not configured
    holidayNotConfigured:
      'ℹ️ Statutory holiday calendar not configured (config.pricingHolidays): holidays and make-up workdays still use the Mon-Fri 9-12 / 14-18 rule, so the tier shown may be wrong.',
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
    // v4.1 P0-1: friendly message for cyclic dependency (no more crash.log)
    runFailedCycle:
      'Workflow {name} has a cyclic dependency ({cycle})\n💡 Edit {name}.yml and remove the mutual depends (e.g. A depends on B and B depends on A), then re-run.',
    runFailedNext:
      '💡 Next: fix the failed step and re-run:\n   concertoai workflow run {name}\nChanges rolled back on A are restored.',
    workflowNotFound:
      'Workflow not found: {name} (generate one with `workflow init` or import a file)',
    workflowParseError:
      'Workflow {name} failed to parse: {message}\n💡 Check YAML syntax (use block-style lists for depends/files:\n   depends:\n     - lint)',
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
    failureSummary: '💡 Summary: {summary}',
    failureStep: '❌ Step {step} failed',
    failureOptions: '[R]etry [S]kip [F]ix and retry [A]bort',
    failurePrompt: 'Choose (R/S/F/A): ',
    failureFixWait:
      'ℹ️ Step {step} needs a manual fix. Edit the code, then press Enter to retry; type a to abort (full rollback). Auto-aborts after {seconds}s without input.',
    failureFixPrompt: 'Waiting for fix (Enter to retry / a to abort): ',
    failureFixInvalid: 'Invalid input (Enter to retry / a to abort).',
    // v4.1 T1.4: pre-run environment preflight + lightweight auto-init
    preflightMissing: '⚠️ Environment not ready ({count} item(s) missing):',
    preflightItemScript: '  - Missing script {name} (can be auto-initialized)',
    preflightItemDep: '  - Dependency not installed: {name} (can be auto-installed)',
    preflightItemConfig: '  - Config file missing: {name} (can be auto-generated)',
    preflightItemManual:
      '  - Missing script {name} (cannot be auto-initialized; configure manually)',
    preflightAskInit: 'Auto-initialize the fixable items above? [Y/n]: ',
    preflightPlanTitle: 'The following initialization steps will run (all require your approval):',
    preflightPlanCmd: '  $ {command}',
    preflightPlanWrite: '  ✎ write {file}',
    preflightPlanScript: '  ✎ package.json scripts.{name} = {command}',
    preflightConfirm: 'Confirm initialization? (y/N): ',
    preflightInitDone: '✅ Environment initialized',
    preflightInitFailed: '❌ Initialization failed: {error} (stopped; fix and retry)',
    preflightSkipped:
      'Skipped initialization; continuing with current config (missing steps may fail)',
    preflightContinue: 'Some items cannot be auto-fixed. Continue anyway? (y/N): ',
    // v4.1 P1-4: explicit stop message when user declines to continue (no silent exit)
    preflightStopped: 'Stopped. Configure the missing items first, then retry.',
    preflightNoTty:
      'Non-interactive environment and prerequisites missing; stopped. Configure the missing items first.',
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
    authCanceled: 'Authentication cancelled (Ctrl+C)',
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
  welcome: {
    // v4.1 T2.2: first-run welcome guide (user feedback 3: beginners don't know the flow)
    title: '🎉 Welcome to ConcertoAI!',
    line1: '  Type a request to start; /help shows slash commands',
    line2: '  Common: /plan plan-first · /review code review · /workflow run workflows',
    line3: '  Health check: concertoai doctor · Quit: Ctrl+C (session saved)',
  },
  help: {
    // v4.1 T2.2: --help grouping + 3-step starter path (user feedback 3)
    gettingStarted: 'Getting started (3 steps)',
    step1: '  ① Health check: concertoai doctor',
    step2: '  ② Start a chat: concertoai chat (or just concertoai)',
    step3: '  ③ Run a workflow: concertoai workflow init && concertoai workflow run <name>',
    commands: 'Command overview',
    exampleChat: '  e.g. concertoai chat · concertoai run "fix this bug" (one-shot)',
    exampleProject: '  e.g. concertoai project add demo . · concertoai team "..." (agent team)',
    exampleOps: '  e.g. concertoai balance · doctor · self-heal · audit export',
    exampleMarket: '  e.g. concertoai plugin browse · provider list · config set provider <name>',
  },
} as const;

export type EnDict = typeof en;
