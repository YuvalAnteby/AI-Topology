// preToolUse hook. Runs before every tool call in every Copilot session for this user.
//
// Two tiers:
//   BASELINE  every repository, every session: blocks commands that destroy work or data
//             (force pushes, hard resets, database drops, recursive deletes outside build folders...)
//   RUN       only while this repository has a sprint run in progress: branch rules,
//             the TDD phase lock, locked rails, no questions to a human who is not there
//
// Reply: {} lets the call through, {"permissionDecision":"deny","permissionDecisionReason":"..."} blocks it.
// A crash also blocks the call, so every rule below is written defensively.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  KIT_HOME,
  PROJECT_DIR_NAME,
  loadConfig,
  loadState,
  projectPaths,
  toRepoPath,
  isOutsideRepo,
  isTestPath,
  isProtectedBranch,
  matchesAny,
  currentBranch,
  readHookEvent,
  respond,
  deny,
  EDIT_TOOL,
  extractEditPaths,
} from './lib.mjs'

const SHELL_TOOL = /^(bash|powershell|shell|run_in_terminal|terminal|execute|run_command)$/i
const ASK_TOOL = /^(ask_user|askuserquestion|ask_question|vscode\/askquestions)$/i
const READ_ONLY_AGENTS = /^(sprint-verifier|sprint-reviewer)$/i
const SIGN = 'Blocked by the sprint-runner guard.'

function userSettings() {
  const file = join(KIT_HOME, 'settings.json')
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}

function main() {
  const ev = readHookEvent()
  const settings = userSettings()
  const config = loadConfig(ev.root)
  const state = loadState(ev.root)
  const unattended = state?.status === 'running'
  const run = unattended || state?.status === 'review'
  const ctx = { ...ev, config, state, run, unattended, baseline: settings.baseline !== false }

  const reason = checkAsk(ctx) || checkShell(ctx) || checkEdit(ctx)
  if (reason) deny(`${reason} ${SIGN}`)
  else respond({})
}

// ---------------------------------------------------------------------------
// questions

function checkAsk({ toolName, unattended, state, root }) {
  if (!unattended || !ASK_TOOL.test(toolName)) return null
  const runs = `${PROJECT_DIR_NAME}/runs/${state.sprint}`
  return (
    `Unattended sprint run: nobody is here to answer. Add the question to ${runs}/decisions.md under "Open questions", ` +
    'then take the conservative reversible default and log it, or block the ticket with sprint-tool block <ticket> "<reason>" and continue.'
  )
}

// ---------------------------------------------------------------------------
// shell commands

function extractCommand(args) {
  for (const key of ['command', 'cmd', 'script', 'input', 'commandLine']) {
    if (typeof args[key] === 'string') return args[key]
  }
  return ''
}

function checkShell(ctx) {
  if (!SHELL_TOOL.test(ctx.toolName)) return null
  const command = extractCommand(ctx.args)
  if (!command) return null
  if (ctx.baseline || ctx.run) {
    for (const [re, msg] of DANGEROUS_PATTERNS) if (re.test(command)) return msg
  }
  return checkCommandLine(command, ctx, 0)
}

// Split at ; && || | and newlines, respecting quotes.
function splitSegments(cmd) {
  const segments = []
  let cur = ''
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ';' || c === '\n' || c === '\r' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      if (cur.trim()) segments.push(cur.trim())
      cur = ''
      if ((c === '|' && cmd[i + 1] === '|') || (c === '&' && cmd[i + 1] === '&')) i++
      continue
    }
    cur += c
  }
  if (cur.trim()) segments.push(cur.trim())
  return segments
}

function tokenize(segment) {
  const tokens = []
  let cur = ''
  let quote = null
  let has = false
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
  }
  if (has || cur) tokens.push(cur)
  return tokens
}

function stripPrefixes(tokens) {
  let t = [...tokens]
  while (t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || ['sudo', 'env', 'command', 'exec', '&', 'time', 'nohup'].includes(t[0]))) {
    t = t.slice(1)
  }
  return t
}

const WRAPPER_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd'])
const WRAPPER_FLAGS = new Set(['-c', '-command', '/c', '/k', '-lc', '-ic'])

function checkCommandLine(command, ctx, depth) {
  if (depth > 3) return 'Too many nested shells to check safely.'
  for (const segment of splitSegments(command)) {
    const tokens = stripPrefixes(tokenize(segment))
    if (tokens.length === 0) continue
    const head = tokens[0].toLowerCase().replace(/\.exe$/, '').split(/[\\/]/).pop()

    if (WRAPPER_SHELLS.has(head)) {
      const fi = tokens.findIndex((t, i) => i > 0 && WRAPPER_FLAGS.has(t.toLowerCase()))
      if (fi > 0 && tokens[fi + 1]) {
        const inner = checkCommandLine(tokens.slice(fi + 1).join(' '), ctx, depth + 1)
        if (inner) return inner
      }
    }
    const r =
      checkGit(head, tokens, ctx) ||
      checkDelete(head, tokens, ctx) ||
      checkRailsTamper(head, tokens, segment, ctx) ||
      checkSprintTool(tokens, ctx)
    if (r) return r
  }
  return null
}

const DANGEROUS_PATTERNS = [
  [/\bdrop\s+(database|schema|table|owned)\b/i, 'Dropping database objects is not allowed for an agent.'],
  [/\btruncate\s+table\b|\b(psql|pg_dump|sqlcmd)\b.*\btruncate\b/i, 'TRUNCATE is not allowed for an agent.'],
  [/\bdropdb\b/i, 'dropdb is not allowed for an agent.'],
  [/\bprisma\s+migrate\s+reset\b/i, 'prisma migrate reset wipes the database.'],
  [/--force-reset\b|--accept-data-loss\b/i, 'Data-loss flags are not allowed for an agent.'],
  [/\bschema:drop\b|\bdb:drop\b|\bdatabase:drop\b/i, 'Dropping the schema is not allowed for an agent.'],
  [/\bdocker(-compose|\s+compose)?\b.*\bdown\b.*(\s-v\b|--volumes\b)/i, 'Removing docker volumes deletes data.'],
  [/\bdocker\s+volume\s+(rm|prune)\b/i, 'Removing docker volumes deletes data.'],
  [/\bdocker\s+(system|image|container)\s+prune\b/i, 'docker prune is not allowed for an agent.'],
  [/\bnpm\s+(publish|unpublish|deprecate)\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i, 'Publishing packages is not allowed for an agent.'],
  [/\b(curl|wget|iwr|invoke-webrequest)\b.*\|\s*(sh|bash|zsh|iex|invoke-expression|pwsh|powershell)\b/i, 'Piping downloads into a shell is not allowed.'],
  [/\bchmod\s+-r\s+777\b/i, 'Recursive chmod 777 is not allowed.'],
  [/\bgit\s+config\s+--(global|system)\b/i, 'Changing global git config is not allowed for an agent.'],
  [/\bformat-volume\b|\bmkfs(\.\w+)?\b|\bdiskpart\b/i, 'Disk formatting commands are not allowed.'],
]

function gitSubcommand(tokens) {
  let i = 1
  let cwdOverride = null
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') {
      cwdOverride = tokens[i + 1]
      i += 2
    } else if (tokens[i] === '-c') i += 2
    else i += 1
  }
  return { sub: tokens[i], rest: tokens.slice(i + 1), cwdOverride }
}

function checkGit(head, tokens, ctx) {
  if (head !== 'git') return null
  const { sub, rest } = gitSubcommand(tokens)
  const { run, baseline, config, cwd, state } = ctx
  const has = (...flags) => rest.some((t) => flags.includes(t))
  const no = (why) => `git ${sub}: ${why}`

  // ---- baseline: never lose work or history ----
  if (baseline || run) {
    switch (sub) {
      case 'push':
        if (rest.some((t) => /^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror|--delete|-d|--prune)$/.test(t))) {
          return no('force, mirror and delete pushes rewrite or remove remote history.')
        }
        if (rest.filter((t) => !t.startsWith('-')).slice(1).some((r) => r.startsWith('+') || r.startsWith(':'))) {
          return no('forced or deleting refspecs rewrite or remove remote history.')
        }
        break
      case 'reset':
        if (has('--hard', '--merge', '--keep')) return no('hard resets discard uncommitted work. Commit or stash instead.')
        break
      case 'clean':
        if (rest.some((t) => /^-[a-zA-Z]*f/.test(t) || t === '--force')) return no('clean -f deletes untracked files for good.')
        break
      case 'checkout':
      case 'restore': {
        if (has('--staged') && !has('--worktree', '-W')) break
        const paths = rest.filter((t) => !t.startsWith('-') && t !== '--')
        if (sub === 'checkout' && !rest.includes('--') && !paths.includes('.')) break
        if (paths.some((p) => p === '.' || p === ':/' || p === '*' || p.endsWith('/'))) {
          return no('discarding changes across the tree loses work. Restore specific files only.')
        }
        break
      }
      case 'branch':
        if (has('-D') || (has('-d', '--delete') && has('-f', '--force'))) return no('force-deleting a branch can lose unmerged commits.')
        break
      case 'stash':
        if (rest[0] === 'drop' || rest[0] === 'clear') return no('dropping stashes loses work.')
        break
      case 'update-ref':
      case 'filter-branch':
      case 'filter-repo':
      case 'replace':
        return no('low-level history rewriting is not allowed for an agent.')
      case 'reflog':
        if (rest[0] === 'expire' || rest[0] === 'delete') return no('expiring the reflog removes recovery points.')
        break
      case 'gc':
        if (rest.some((t) => t.startsWith('--prune'))) return no('pruning objects removes recovery points.')
        break
    }
  }

  // ---- run: the branch model of a sprint ----
  if (!run) return null
  switch (sub) {
    case 'push': {
      if (!config.pushBranches) return no('pushBranches is off in .sprint-runner/config.json, so the human pushes. The handoff index lists the push command.')
      if (has('--all', '--tags')) return no('bulk pushes are not part of a sprint run.')
      const refspecs = rest.filter((t) => !t.startsWith('-')).slice(1)
      const targets = refspecs.length
        ? refspecs.map((r) => (r.includes(':') ? r.split(':')[1] : r).replace(/^refs\/heads\//, ''))
        : [currentBranch(cwd)]
      for (let t of targets) {
        if (!t || t === 'HEAD') t = currentBranch(cwd)
        if (!t || isProtectedBranch(t, config) || !(t.startsWith(config.sprintBranchPrefix) || t.startsWith(config.ticketBranchPrefix))) {
          return no(`pushing "${t}" is not allowed during a run. Only ${config.sprintBranchPrefix}* and ${config.ticketBranchPrefix}* branches are pushed.`)
        }
      }
      return null
    }
    case 'rebase':
      return no('history is never rewritten in a sprint run. Merge the lower branch up instead (sprint-tool merge-up).')
    case 'branch':
      if (has('-d', '--delete', '-m', '-M', '--move') && rest.filter((t) => !t.startsWith('-')).some((n) => isProtectedBranch(n, config))) {
        return no('deleting or renaming protected branches is not allowed.')
      }
      return null
    case 'tag':
      if (has('-d', '--delete', '-f', '--force')) return no('deleting or moving tags is not allowed during a run.')
      return null
    case 'merge':
      if (currentBranch(cwd) === state?.sprintBranch) return no(`merging into ${state.sprintBranch} is the human's step after review. The handoff files list the merge commands.`)
    // falls through
    case 'commit':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'pull': {
      if (sub === 'commit' && has('--no-verify', '-n')) return no('skipping git hooks is not allowed during a run.')
      const cb = currentBranch(cwd)
      if (cb && isProtectedBranch(cb, config)) return no(`"${cb}" is protected. Sprint work happens on ${config.sprintBranchPrefix}* and ${config.ticketBranchPrefix}* branches.`)
      return null
    }
  }
  return null
}

const SAFE_DELETE_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', '.turbo', '.next', '.cache', 'playwright-report', 'test-results', 'tmp', '.tmp']

function isSafeDeleteTarget(target, ctx) {
  if (!target || ['.', '..', '/', '~', '\\'].includes(target) || target.includes('*') || target.includes('$')) return false
  const p = toRepoPath(target, ctx.cwd, ctx.root)
  if (!ctx.root || isOutsideRepo(p) || p === '') return false
  if (p.startsWith(`${PROJECT_DIR_NAME}/runs/`) && !p.endsWith('state.json')) return true
  return p.split('/').some((seg) => SAFE_DELETE_DIRS.includes(seg))
}

function checkDelete(head, tokens, ctx) {
  if (!ctx.baseline && !ctx.run) return null
  const isRm = head === 'rm'
  const isPs = ['remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'].includes(head)
  if (!isRm && !isPs) return null
  const args = tokens.slice(1)
  const flags = args.filter((t) => t.startsWith('-') || /^\/[a-zA-Z]$/.test(t))
  const targets = args.filter((t) => !t.startsWith('-') && !/^\/[a-zA-Z]$/.test(t))
  const recursive = isRm
    ? flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive')
    : flags.some((f) => /^-r(ecurse)?$/i.test(f) || /^\/s$/i.test(f)) || head === 'rd' || head === 'rmdir'
  if (!recursive) return null
  if (targets.length && targets.every((t) => isSafeDeleteTarget(t, ctx))) return null
  return `Recursive delete of ${targets.join(', ') || '(no target)'} is not allowed for an agent. Only build output inside the repository (node_modules, dist, build, coverage...) can be removed recursively.`
}

const READ_ONLY_CMDS = new Set(['cat', 'type', 'less', 'more', 'head', 'tail', 'ls', 'dir', 'get-content', 'gc', 'get-childitem', 'gci', 'wc', 'grep', 'rg', 'findstr', 'select-string'])

function railMarkers() {
  const kit = KIT_HOME.replace(/\\/g, '/')
  return [
    `${PROJECT_DIR_NAME}/config.json`,
    `${PROJECT_DIR_NAME}/rubric.md`,
    `${PROJECT_DIR_NAME}/templates`,
    `${PROJECT_DIR_NAME}/handoff`,
    'runs/state.json',
    kit,
    '.copilot/agents',
    '.copilot/hooks',
    '.copilot/sprint-runner',
  ]
}

function checkRailsTamper(head, tokens, segment, { run }) {
  if (!run) return null
  const s = segment.replace(/\\/g, '/')
  if (!railMarkers().some((m) => s.includes(m))) return null
  if (READ_ONLY_CMDS.has(head)) return null
  if (head === 'git' && ['diff', 'log', 'show', 'status', 'blame', 'ls-files'].includes(gitSubcommand(tokens).sub)) return null
  if (head === 'node' && tokens.some((t) => t.replace(/\\/g, '/').endsWith('/sprint-tool.mjs'))) return null
  return 'The sprint-runner agents, hooks, project config, rubric, templates and run state are locked during a run.'
}

const ROOT_ONLY = new Set(['setup', 'handoff', 'init', 'start', 'begin', 'phase', 'red-done', 'commit', 'done', 'block', 'skip', 'finish', 'abort', 'merge-up', 'reopen', 'resume'])

function checkSprintTool(tokens, { isSubagent }) {
  const i = tokens.findIndex((t) => t.replace(/\\/g, '/').endsWith('sprint-tool.mjs'))
  if (i < 0 || !isSubagent || !ROOT_ONLY.has(tokens[i + 1])) return null
  return `Only the sprint-runner can change run state ("sprint-tool ${tokens[i + 1]}"). Report back to it instead.`
}

// ---------------------------------------------------------------------------
// file edits

function checkEdit(ctx) {
  if (!EDIT_TOOL.test(ctx.toolName)) return null
  const { root, cwd, run, state, config, agentType } = ctx
  const paths = extractEditPaths(ctx.args).map((p) => toRepoPath(p, cwd, root))
  if (paths.length === 0) return null
  const runsPrefix = `${PROJECT_DIR_NAME}/runs/`
  const isReport = (p) => p && p.startsWith(runsPrefix) && !p.endsWith('state.json')

  if (READ_ONLY_AGENTS.test(agentType)) {
    const bad = paths.find((p) => !isReport(p))
    if (bad !== undefined) return `The ${agentType} agent is read-only and may only write its report under ${runsPrefix} ("${bad}").`
  }

  for (const p of paths) {
    if (p === `${runsPrefix}state.json`) return 'Run state changes only through sprint-tool.'
    if (!run) continue
    if (isOutsideRepo(p)) return `Editing files outside the repository (${p}) is not allowed during a run.`
    if (matchesAny(p, [`${PROJECT_DIR_NAME}/config.json`, `${PROJECT_DIR_NAME}/rubric.md`, `${PROJECT_DIR_NAME}/templates/**`, `${PROJECT_DIR_NAME}/handoff/**`, `${PROJECT_DIR_NAME}/runs/*/tickets/**`])) {
      return `"${p}" is locked during a run.`
    }
    if (isReport(p)) continue
    const phase = state?.current?.phase || 'idle'
    const ticket = state?.current?.ticket || '(none)'
    const test = isTestPath(p, config)
    if (phase === 'red') {
      if (!test) return `TDD phase lock: ${ticket} is in RED, so only test files can change. "${p}" is production code. Write the failing test that describes it instead.`
      continue
    }
    if (['green', 'refactor', 'fix'].includes(phase)) {
      if (test) return `TDD phase lock: ${ticket} is in ${phase.toUpperCase()}, so test files are frozen. "${p}" is a test file. Make the code satisfy the test. If the test is wrong, stop and report it to the sprint-runner.`
      continue
    }
    return `No code changes are allowed while ${ticket} is in the ${phase.toUpperCase()} phase.`
  }
  return null
}

try {
  main()
} catch (err) {
  deny(`Guard error: ${err && err.message}. Fix the guard, or set "baseline": false in the sprint-runner settings.json and abort any run to stop it from interfering. ${SIGN}`)
}
