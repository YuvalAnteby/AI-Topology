#!/usr/bin/env node
// sprint-tool: the deterministic half of a sprint run.
// The sprint-runner agent calls it for every state change, branch move and commit,
// so git history and the TDD gates never depend on the model remembering a rule.
//
// Run it from anywhere inside a repository. It works on that repository.
// Usage: node <kit>/bin/sprint-tool.mjs <command> [args]
//   paths [--json]                    where this project's config, rubric, templates and runs live
//   setup                             opt this repository in: create .sprint-runner/config.json
//   init <sprint-id> --order <file>   create the sprint branch and run state (status: preflight)
//   start                             end pre-flight, begin the unattended run (needs decisions.md)
//   next                              print the next ticket to work on, auto-skipping blocked chains
//   begin <ticket>                    create ticket/<id> off the chain tip, phase PLAN
//   phase <ticket> <phase>            plan | red | green | refactor | fix | review | idle
//   red-done <ticket>                 verify only tests changed, commit them, phase GREEN
//   green-check <ticket>              verify no test file changed since the RED commit (read-only)
//   commit <ticket>                   green-check, then commit the implementation
//   handoff <ticket> --body <file>    write the ticket's PR title, description and merge steps to the main worktree
//   handoff --sprint --body <file>    the same for the whole sprint (sprint branch into the base branch)
//   done <ticket>                     mark done, move the chain tip to this ticket
//   block <ticket> <reason>           park the work on its branch, return to the chain tip
//   skip <ticket> <reason>            mark skipped without touching git
//   merge-up <ticket>                 merge a fixed ticket into every later done ticket (no rewrites)
//   reopen <ticket>                   attended session: reopen a done ticket to address PR review comments
//   resume                            continue a stalled or stopped run
//   status [--json]                   show the run
//   finish                            close a run whose tickets are all done, blocked or skipped
//   abort <reason>                    stop the run now
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, isAbsolute, dirname } from 'node:path'
import {
  KIT_HOME,
  PROJECT_DIR_NAME,
  findRepoRoot,
  projectPaths,
  defaultConfig,
  ensureRunsDir as ensureRunsDirFor,
  loadConfig,
  loadState as loadStateFor,
  saveState as saveStateFor,
  isTestPath,
  git,
  tryGit,
  currentBranch as currentBranchIn,
  mainWorktree,
  changedPathsSince as changedPathsSinceIn,
} from './lib.mjs'

const PHASES = ['plan', 'red', 'green', 'refactor', 'fix', 'review', 'idle']
const TERMINAL = ['done', 'blocked', 'skipped']

const [, , command, ...argv] = process.argv
const ROOT = findRepoRoot(process.cwd())
const PATHS = ROOT ? projectPaths(ROOT) : null
const config = loadConfig(ROOT)
const RUNS_DIR = PATHS ? PATHS.runs : null

const g = (args) => git(args, { cwd: ROOT })
const tg = (args) => tryGit(args, { cwd: ROOT })
const loadState = () => loadStateFor(ROOT)
const saveState = (s) => saveStateFor(ROOT, s)
const ensureRunsDir = () => ensureRunsDirFor(ROOT)
const currentBranch = () => currentBranchIn(ROOT)
const changedPathsSince = (base) => changedPathsSinceIn(base, ROOT)

function fail(msg, code = 1) {
  process.stderr.write(`sprint-tool: ${msg}\n`)
  process.exit(code)
}
function ok(msg) {
  process.stdout.write(msg + '\n')
}
function flag(name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
function requireState() {
  const s = loadState()
  if (!s) fail('no sprint run found. Run "init" first.')
  return s
}
function requireRunning(s) {
  if (s.status !== 'running') fail(`the run is "${s.status}", not running.`)
}
function requireActive(s) {
  if (s.status !== 'running' && s.status !== 'review') fail(`the run is "${s.status}". Use "start", "resume" or "reopen" first.`)
}
function ticketOf(s, id) {
  const t = s.tickets.find((x) => x.id === id)
  if (!t) fail(`unknown ticket "${id}". Known: ${s.tickets.map((x) => x.id).join(', ')}`)
  return t
}
function runDir(s) {
  const d = join(RUNS_DIR, s.sprint)
  mkdirSync(d, { recursive: true })
  return d
}
function isClean({ ignoreProjectDir = false } = {}) {
  const lines = (tg(['status', '--porcelain', '--untracked-files=all']) || '').split('\n').filter(Boolean)
  // git output is trimmed, so the two status columns may have lost their leading space
  const path = (l) => l.trim().replace(/^\S+\s+/, '').replace(/^"/, '')
  return lines.filter((l) => !(ignoreProjectDir && path(l).startsWith(PROJECT_DIR_NAME + '/'))).length === 0
}
function fmt(template, t) {
  return template.replace('{ticket}', t.id).replace('{title}', t.title || t.id)
}
function commitAll(message, { allowEmpty = false, noVerify = false } = {}) {
  g(['add', '-A'])
  const staged = tg(['diff', '--cached', '--name-only'])
  if (!staged && !allowEmpty) return false
  const args = ['commit', '-m', message]
  if (noVerify) args.push('--no-verify')
  git(args)
  return true
}

const commands = {
  paths() {
    const out = { ...PATHS, configExists: existsSync(PATHS.config), sprintRunning: loadState()?.status === 'running' }
    if (argv.includes('--json')) return ok(JSON.stringify(out, null, 2))
    ok(Object.entries(out).map(([k, v]) => `${k.padEnd(14)} ${v}`).join('\n'))
  },

  setup() {
    if (existsSync(PATHS.config)) {
      ensureRunsDir()
      return ok(`Already set up: ${relative(ROOT, PATHS.config)}. Edit it to change branches, test globs or checks.`)
    }
    mkdirSync(PATHS.projectDir, { recursive: true })
    const cfg = defaultConfig()
    // Fill what can be detected safely: the default branch and package scripts.
    const remoteHead = tg(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (remoteHead) cfg.baseBranch = remoteHead.replace(/^origin\//, '')
    else if (tg(['rev-parse', '--verify', '--quiet', 'refs/heads/dev'])) cfg.baseBranch = 'dev'
    cfg.checks = detectChecks()
    writeFileSync(PATHS.config, JSON.stringify(cfg, null, 2) + '\n')
    ensureRunsDir()
    ok(
      [
        `Created ${PROJECT_DIR_NAME}/config.json (base branch: ${cfg.baseBranch}, ${cfg.checks.length} checks detected).`,
        'Review it: ticketSource (where tickets come from), test globs, check commands, protected branches.',
        `Optional: copy ${join(KIT_HOME, 'defaults', 'rubric.md')} to ${PROJECT_DIR_NAME}/rubric.md for a project-specific rubric.`,
        `${PROJECT_DIR_NAME}/runs/ ignores itself in git. Commit the rest of ${PROJECT_DIR_NAME}/.`,
      ].join('\n'),
    )
  },

  init() {
    const sprint = argv[0]
    const orderFile = flag('--order')
    if (!sprint || !orderFile) fail('usage: init <sprint-id> --order <file>')
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(sprint)) fail('sprint id may only contain letters, digits, dot, dash and underscore.')
    const existing = loadState()
    if (existing && existing.status === 'running') fail(`a run for "${existing.sprint}" is still running. Finish or abort it first.`)
    if (!config.optedIn) fail(`this repository has no ${PROJECT_DIR_NAME}/config.json. Run "setup" first.`)
    const orderPath = isAbsolute(orderFile) ? orderFile : join(ROOT, orderFile)
    if (!existsSync(orderPath)) fail(`order file not found: ${orderFile}`)
    const order = JSON.parse(readFileSync(orderPath, 'utf8'))
    if (!Array.isArray(order) || order.length === 0) fail('order file must be a non-empty JSON array.')
    ensureRunsDir()
    const ids = new Set()
    for (const t of order) {
      if (!t.id) fail('every ticket needs an "id".')
      for (const d of t.dependsOn || []) {
        if (!ids.has(d) && order.some((o) => o.id === d)) fail(`${t.id} depends on ${d}, which comes later in the order. Put dependencies first.`)
      }
      ids.add(t.id)
    }
    if (!isClean({ ignoreProjectDir: true })) fail('the working tree has uncommitted changes. Commit or stash them before starting a sprint.')

    const sprintBranch = config.sprintBranchPrefix + sprint
    const remoteBase = `${config.remote}/${config.baseBranch}`
    tg(['fetch', config.remote, config.baseBranch])

    // Carry uncommitted sprint-runner project files (config, rubric, templates) across the
    // branch switch: hold their contents, restore the tree, switch, then write them back.
    const carried = new Map()
    const statusLines = (tg(['status', '--porcelain', '--untracked-files=all', '--', PROJECT_DIR_NAME]) || '').split('\n').filter(Boolean)
    for (const line of statusLines) {
      const code = line.trim().split(/\s+/)[0]
      const rel = line.trim().replace(/^\S+\s+/, '').replace(/^"|"$/g, '')
      const abs = join(ROOT, rel)
      if (!existsSync(abs)) continue
      carried.set(rel, readFileSync(abs))
      if (code === '??') rmSync(abs)
      else g(['checkout', 'HEAD', '--', rel])
    }
    if (tg(['rev-parse', '--verify', '--quiet', `refs/heads/${sprintBranch}`])) {
      g(['switch', sprintBranch])
    } else {
      const start = tg(['rev-parse', '--verify', '--quiet', remoteBase]) ? remoteBase : config.baseBranch
      g(['switch', '-c', sprintBranch, start])
    }
    // New or changed sprint-runner project files (config, rubric, templates) become the first
    // commit on the sprint branch, so they reach the base branch through the sprint's review.
    for (const [rel, content] of carried) {
      mkdirSync(dirname(join(ROOT, rel)), { recursive: true })
      writeFileSync(join(ROOT, rel), content)
    }
    const projectChanges = (tg(['status', '--porcelain', '--untracked-files=all', '--', PROJECT_DIR_NAME]) || '').trim()
    if (projectChanges) {
      g(['add', '--', PROJECT_DIR_NAME])
      g(['commit', '-m', `chore(${sprint}): sprint-runner project config`])
    }

    const state = {
      version: 1,
      sprint,
      status: 'preflight',
      baseBranch: config.baseBranch,
      sprintBranch,
      prMode: config.prMode,
      chainTip: sprintBranch,
      current: null,
      stopBlocks: 0,
      createdAt: new Date().toISOString(),
      tickets: order.map((t) => ({
        id: t.id,
        title: t.title || t.id,
        file: t.file || null,
        dependsOn: (t.dependsOn || []).filter((d) => order.some((o) => o.id === d)),
        ui: Boolean(t.ui),
        status: t.skip ? 'skipped' : 'todo',
        note: t.skip ? String(t.skip) : null,
        branch: config.ticketBranchPrefix + t.id,
        parentBranch: null,
        redCommit: null,
        reviewLoops: 0,
        pr: null,
      })),
    }
    saveState(state)
    runDir(state)
    ok(`Initialized ${sprint} on ${sprintBranch} with ${state.tickets.length} tickets. Status: preflight.`)
  },

  start() {
    const s = requireState()
    if (s.status !== 'preflight') fail(`cannot start from status "${s.status}".`)
    const decisions = join(runDir(s), 'decisions.md')
    if (!existsSync(decisions)) fail(`write ${relative(ROOT, decisions).replace(/\\/g, '/')} with the human's answers before starting.`)
    s.status = 'running'
    s.startedAt = new Date().toISOString()
    saveState(s)
    ok(`Run started for ${s.sprint}. Next: ${pickNext(s) || 'nothing to do'}`)
  },

  next() {
    const s = requireState()
    requireRunning(s)
    const id = pickNext(s)
    saveState(s)
    ok(id || 'NONE')
  },

  begin() {
    const s = requireState()
    requireRunning(s)
    const t = ticketOf(s, argv[0])
    if (t.status !== 'todo' && t.status !== 'in_progress') fail(`${t.id} is ${t.status}.`)
    if (s.current && s.current.ticket !== t.id && s.current.phase !== 'idle') fail(`${s.current.ticket} is still in ${s.current.phase}. Finish, block or skip it first.`)
    const unmet = t.dependsOn.filter((d) => ticketOf(s, d).status !== 'done')
    if (unmet.length) fail(`${t.id} waits on ${unmet.join(', ')}.`)
    if (!isClean()) fail('the working tree has uncommitted changes. Commit, block or clean up the previous ticket first.')

    if (tg(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`])) {
      g(['switch', t.branch])
    } else {
      g(['switch', '-c', t.branch, s.chainTip])
      t.parentBranch = s.chainTip
    }
    t.parentBranch = t.parentBranch || s.chainTip
    t.status = 'in_progress'
    t.startedAt = t.startedAt || new Date().toISOString()
    s.current = { ticket: t.id, phase: 'plan' }
    saveState(s)
    mkdirSync(join(runDir(s), t.id), { recursive: true })
    ok(`${t.id} on ${t.branch} (from ${t.parentBranch}). Phase: PLAN. Notes folder: ${PROJECT_DIR_NAME}/runs/${s.sprint}/${t.id}/`)
  },

  phase() {
    const s = requireState()
    requireActive(s)
    const t = ticketOf(s, argv[0])
    const phase = argv[1]
    if (!PHASES.includes(phase)) fail(`phase must be one of ${PHASES.join(', ')}.`)
    if (!s.current || s.current.ticket !== t.id) fail(`${t.id} is not the current ticket.`)
    if (['green', 'refactor', 'fix', 'review'].includes(phase) && !t.redCommit) fail(`${t.id} has no RED commit yet. Run red-done first.`)
    if (phase === 'fix') {
      t.reviewLoops += 1
      if (t.reviewLoops > config.maxReviewLoops) {
        t.reviewLoops -= 1
        saveState(s)
        fail(`${t.id} already used ${config.maxReviewLoops} review fix loops. Block it with the remaining findings.`, 3)
      }
    }
    if (phase === 'red' && t.redCommit) {
      // Re-entering RED to correct a wrong test. Commit the implementation first so only the
      // test fix lands in the next RED commit, which then becomes the new frozen baseline.
      if (!isClean()) fail(`commit the current implementation ("commit ${t.id}") before re-entering RED.`)
      t.prevRedCommits = [...(t.prevRedCommits || []), t.redCommit]
      t.redCommit = null
    }
    s.current.phase = phase
    saveState(s)
    ok(`${t.id}: phase ${phase.toUpperCase()}${phase === 'fix' ? ` (loop ${t.reviewLoops}/${config.maxReviewLoops})` : ''}`)
  },

  'red-done'() {
    const s = requireState()
    requireActive(s)
    const t = ticketOf(s, argv[0])
    if (s.current?.ticket !== t.id || s.current.phase !== 'red') fail(`${t.id} is not in RED.`)
    const correction = Boolean(t.prevRedCommits?.length)
    // First RED: everything since the parent branch must be tests. A correction: only the new edits.
    const changed = changedPathsSince(correction ? 'HEAD' : t.parentBranch).filter((p) => !p.startsWith(PROJECT_DIR_NAME + '/runs/'))
    const nonTest = changed.filter((p) => !isTestPath(p, config))
    if (nonTest.length) fail(`RED may only change test files. Production files changed:\n  ${nonTest.join('\n  ')}`, 2)
    if (!changed.some((p) => isTestPath(p, config))) fail('no test files changed. RED needs at least one failing test.', 2)
    const message = correction ? `test(${t.id}): correct tests after review` : fmt(config.commitFormat.red, t)
    commitAll(message)
    t.redCommit = g(['rev-parse', 'HEAD'])
    s.current.phase = 'green'
    saveState(s)
    ok(`${t.id}: RED committed at ${t.redCommit.slice(0, 9)}. Phase: GREEN. Test files are now frozen.`)
  },

  'green-check'() {
    const s = requireState()
    const t = ticketOf(s, argv[0])
    if (!t.redCommit) fail(`${t.id} has no RED commit.`)
    const touched = testsTouchedSinceRed(t)
    if (touched.length) {
      fail(`test files changed after the RED commit:\n  ${touched.join('\n  ')}\nRestore them with: git restore --source ${t.redCommit.slice(0, 9)} -- <file>`, 2)
    }
    ok(`${t.id}: test files unchanged since RED (${t.redCommit.slice(0, 9)}).`)
  },

  commit() {
    const s = requireState()
    requireActive(s)
    const t = ticketOf(s, argv[0])
    const touched = testsTouchedSinceRed(t)
    if (touched.length) fail(`refusing to commit: test files changed after RED:\n  ${touched.join('\n  ')}`, 2)
    const phase = s.current?.ticket === t.id ? s.current.phase : 'green'
    const byPhase = {
      green: fmt(config.commitFormat.green, t),
      refactor: `refactor(${t.id}): simplify`,
      fix: `fix(${t.id}): address review findings (loop ${t.reviewLoops})`,
    }
    const made = commitAll(flag('--message') || byPhase[phase] || fmt(config.commitFormat.green, t))
    ok(made ? `${t.id}: implementation committed at ${g(['rev-parse', '--short', 'HEAD'])}.` : `${t.id}: nothing new to commit.`)
  },

  done() {
    const s = requireState()
    requireActive(s)
    const t = ticketOf(s, argv[0])
    if (t.status !== 'in_progress') fail(`${t.id} is ${t.status}.`)
    if (!isClean()) fail('uncommitted changes remain. Run "commit" first.')
    if (testsTouchedSinceRed(t).length) fail('test files changed after RED.', 2)
    if (s.prMode === 'chained' && !t.handoff) fail(`write the handoff first: handoff ${t.id} --body <pr.md>`)
    t.status = 'done'
    t.finishedAt = new Date().toISOString()
    s.stopBlocks = 0
    if (t.reopened) {
      // a review fix on an earlier ticket: the chain tip stays where it is
      delete t.reopened
      s.current = null
      if (s.resumeStatus && !s.tickets.some((x) => x.status === 'in_progress')) {
        s.status = s.resumeStatus
        delete s.resumeStatus
      }
      saveState(s)
      writeIndex(s)
      return ok(`${t.id}: review fixes done. Run "merge-up ${t.id}" to carry the fix into later tickets.`)
    }
    s.chainTip = t.branch
    s.current = { ticket: t.id, phase: 'idle' }
    saveState(s)
    ok(`${t.id}: done. Chain tip is now ${t.branch}. Next: ${pickNext(s) || 'NONE'}`)
    saveState(s)
    writeIndex(s)
  },

  block() {
    const s = requireState()
    requireActive(s)
    const t = ticketOf(s, argv[0])
    const reason = argv.slice(1).join(' ').trim()
    if (!reason) fail('usage: block <ticket> <reason>')
    if (currentBranch() === t.branch && !isClean()) {
      commitAll(`wip(${t.id}): blocked - ${reason}`.slice(0, 200), { noVerify: true })
    }
    if (currentBranch() !== s.chainTip) g(['switch', s.chainTip])
    t.status = 'blocked'
    t.note = reason
    t.finishedAt = new Date().toISOString()
    s.current = { ticket: t.id, phase: 'idle' }
    s.stopBlocks = 0
    saveState(s)
    ok(`${t.id}: blocked (${reason}). Work kept on ${t.branch}. Back on ${s.chainTip}. Next: ${pickNext(s) || 'NONE'}`)
    saveState(s)
    writeIndex(s)
  },

  skip() {
    const s = requireState()
    const t = ticketOf(s, argv[0])
    const reason = argv.slice(1).join(' ').trim()
    if (!reason) fail('usage: skip <ticket> <reason>')
    if (t.status === 'in_progress') fail(`${t.id} is in progress. Use block instead.`)
    t.status = 'skipped'
    t.note = reason
    saveState(s)
    ok(`${t.id}: skipped (${reason}).`)
  },

  'merge-up'() {
    const s = requireState()
    const t = ticketOf(s, argv[0])
    if (!isClean()) fail('commit the fix before merging it up.')
    const chain = s.tickets.filter((x) => x.status === 'done')
    const idx = chain.findIndex((x) => x.id === t.id)
    if (idx < 0) fail(`${t.id} is not a done ticket in the chain.`)
    const start = currentBranch()
    let prev = t.branch
    const merged = []
    for (const next of chain.slice(idx + 1)) {
      g(['switch', next.branch])
      try {
        g(['merge', '--no-edit', prev])
      } catch {
        tg(['merge', '--abort'])
        g(['switch', start])
        fail(`merge conflict merging ${prev} into ${next.branch}. Nothing was changed. Resolve it as a separate fix on ${next.branch}.`, 2)
      }
      merged.push(next.branch)
      prev = next.branch
    }
    g(['switch', start])
    ok(merged.length ? `Merged ${t.branch} up through: ${merged.join(' -> ')}.${config.pushBranches ? ' Push each of these branches.' : ''}` : 'No later tickets to update.')
  },

  handoff() {
    const s = requireState()
    if (s.status === 'preflight') fail('nothing to hand off before the run starts.')
    const bodyFile = flag('--body')
    if (!bodyFile) fail('usage: handoff <ticket> --body <file> | handoff --sprint --body <file>')
    const bodyPath = isAbsolute(bodyFile) ? bodyFile : join(process.cwd(), bodyFile)
    if (!existsSync(bodyPath)) fail(`body file not found: ${bodyFile}`)
    const raw = readFileSync(bodyPath, 'utf8').replace(/\r\n/g, '\n')
    const titleMatch = raw.match(/^#\s+(.+)$/m)
    const body = titleMatch ? raw.replace(titleMatch[0], '').trim() : raw.trim()
    const dir = handoffDir(s)

    if (argv.includes('--sprint')) {
      const done = s.tickets.filter((t) => t.status === 'done')
      if (!done.length) fail('no done tickets to hand off.')
      if (s.prMode === 'single' && s.chainTip !== s.sprintBranch) {
        // the sprint branch moves forward to the last done ticket (fast-forward only)
        if (tg(['merge-base', '--is-ancestor', s.sprintBranch, s.chainTip]) === null) fail(`${s.sprintBranch} is not an ancestor of ${s.chainTip}. Refusing to move it.`)
        if (currentBranch() === s.sprintBranch) g(['merge', '--ff-only', s.chainTip])
        else g(['branch', '-f', s.sprintBranch, s.chainTip])
      }
      const file = join(dir, '00-sprint.md')
      writeFileSync(file, renderHandoff(s, {
        title: titleMatch ? titleMatch[1].trim() : `${s.sprint}: sprint ${s.sprint}`,
        source: s.sprintBranch,
        target: s.baseBranch,
        mergeInto: s.baseBranch,
        note: s.prMode === 'chained' ? `Open this one after every ticket PR is merged into \`${s.sprintBranch}\`.` : null,
        body,
      }))
      s.sprintHandoff = file
      saveState(s)
      writeIndex(s)
      return ok(`Sprint handoff written: ${file}`)
    }

    const t = ticketOf(s, argv[0])
    if (s.prMode === 'single') fail('prMode is "single": hand off the whole sprint with handoff --sprint instead.')
    if (!['in_progress', 'done'].includes(t.status)) fail(`${t.id} is ${t.status}.`)
    if (!isClean()) fail('commit everything before the handoff.')
    const idx = s.tickets.findIndex((x) => x.id === t.id) + 1
    const file = join(dir, `${String(idx).padStart(2, '0')}-${t.id}.md`)
    const parentIsTicket = t.parentBranch && t.parentBranch.startsWith(config.ticketBranchPrefix)
    writeFileSync(file, renderHandoff(s, {
      title: titleMatch ? titleMatch[1].trim() : `${t.id}: ${t.title}`,
      source: t.branch,
      target: t.parentBranch,
      mergeInto: s.sprintBranch,
      note: parentIsTicket ? `Built on the previous ticket's branch, so diffing against \`${t.parentBranch}\` shows only this ticket. It merges into \`${s.sprintBranch}\` after \`${t.parentBranch}\` does.` : null,
      body,
    }))
    t.handoff = file
    saveState(s)
    writeIndex(s)
    ok(`${t.id}: handoff written: ${file}`)
  },

  reopen() {
    const s = requireState()
    const t = ticketOf(s, argv[0])
    if (s.status === 'running' || s.status === 'preflight') fail(`the sprint run is still "${s.status}". Address review comments after it finishes or stalls.`)
    if (t.status !== 'done') fail(`${t.id} is ${t.status}. Only done tickets can be reopened for review fixes.`)
    if (!isClean()) fail('the working tree has uncommitted changes.')
    g(['switch', t.branch])
    s.resumeStatus = s.status === 'review' ? s.resumeStatus : s.status
    s.status = 'review'
    t.status = 'in_progress'
    t.reopened = true
    t.reviewLoops = 0
    s.current = { ticket: t.id, phase: 'fix' }
    saveState(s)
    ok(`${t.id}: reopened on ${t.branch} in FIX (attended review session). Test files stay frozen unless you re-enter RED.`)
  },

  resume() {
    const s = requireState()
    if (s.status !== 'stalled' && s.status !== 'stopped') fail(`nothing to resume: the run is "${s.status}".`)
    s.status = 'running'
    s.stopBlocks = 0
    delete s.lastStopSignature
    saveState(s)
    ok(`Run for ${s.sprint} resumed.${s.current ? ` Current: ${s.current.ticket} (${s.current.phase}).` : ''} Next: ${pickNext(s) || 'NONE'}`)
    saveState(s)
  },

  status() {
    const s = requireState()
    if (argv.includes('--json')) return ok(JSON.stringify(s, null, 2))
    const lines = [
      `Sprint ${s.sprint} | status ${s.status} | mode ${s.prMode} | chain tip ${s.chainTip}`,
      s.current ? `Current: ${s.current.ticket} (${s.current.phase})` : 'Current: none',
      '',
      ...s.tickets.map((t) => `${t.status.padEnd(11)} ${t.id.padEnd(10)} ${t.title}${t.reviewLoops ? ` [loops ${t.reviewLoops}]` : ''}${t.handoff ? ` -> ${t.handoff}` : ''}${t.note ? ` - ${t.note}` : ''}`),
    ]
    ok(lines.join('\n'))
  },

  finish() {
    const s = requireState()
    requireRunning(s)
    const open = s.tickets.filter((t) => !TERMINAL.includes(t.status))
    if (open.length) fail(`not finished: ${open.map((t) => `${t.id} (${t.status})`).join(', ')}`)
    if (!existsSync(join(runDir(s), 'report.md'))) fail(`write ${PROJECT_DIR_NAME}/runs/${s.sprint}/report.md first.`)
    s.status = 'finished'
    s.current = null
    s.finishedAt = new Date().toISOString()
    saveState(s)
    const index = writeIndex(s)
    ok(`Run for ${s.sprint} finished. Handoff index: ${index}`)
  },

  abort() {
    const s = requireState()
    s.status = 'stopped'
    s.note = argv.join(' ') || 'aborted'
    s.current = null
    saveState(s)
    ok(`Run for ${s.sprint} stopped: ${s.note}`)
  },
}

// package.json scripts at the root and one level down (backend/, frontend/, apps/x is two levels: add by hand)
function detectChecks() {
  const checks = []
  const dirs = ['.']
  for (const d of tg(['ls-files', '*/package.json']) ? tg(['ls-files', '*/package.json']).split('\n') : []) {
    const dir = d.replace(/\/package\.json$/, '')
    if (!dir.includes('/')) dirs.push(dir)
  }
  for (const dir of dirs) {
    const file = join(ROOT, dir, 'package.json')
    if (!existsSync(file)) continue
    let scripts = {}
    try {
      scripts = JSON.parse(readFileSync(file, 'utf8')).scripts || {}
    } catch {
      continue
    }
    const label = dir === '.' ? '' : `${dir} `
    if (scripts.test) checks.push({ name: `${label}tests`, cwd: dir, cmd: 'npm test' })
    if (scripts.lint) checks.push({ name: `${label}lint`, cwd: dir, cmd: 'npm run lint' })
    for (const k of ['typecheck', 'type-check', 'check-types', 'tsc']) {
      if (scripts[k]) {
        checks.push({ name: `${label}typecheck`, cwd: dir, cmd: `npm run ${k}` })
        break
      }
    }
  }
  return checks
}

function handoffDir(s) {
  const main = mainWorktree(ROOT)
  const rootDir = join(main, config.handoffDir || `${PROJECT_DIR_NAME}/handoff`)
  mkdirSync(rootDir, { recursive: true })
  if (!existsSync(join(rootDir, '.gitignore'))) writeFileSync(join(rootDir, '.gitignore'), '*\n')
  const dir = join(rootDir, s.sprint)
  mkdirSync(dir, { recursive: true })
  return dir
}

function renderHandoff(s, { title, source, target, mergeInto, note, body }) {
  const commits = (tg(['log', '--oneline', '--no-decorate', `${target}..${source}`]) || '').split('\n').filter(Boolean)
  const stat = (tg(['diff', '--shortstat', `${target}...${source}`]) || '').trim()
  return [
    `# ${title}`,
    '',
    '| | |',
    '|---|---|',
    `| **Title** | ${title} |`,
    `| **Source branch** | \`${source}\` |`,
    `| **Target branch** | \`${target}\` |`,
    `| **Size** | ${commits.length} commits${stat ? `, ${stat}` : ''} |`,
    note ? `| **Note** | ${note} |` : null,
    '',
    '## Description',
    '',
    body,
    '',
    '## Commits',
    '',
    ...commits.map((c) => `- \`${c}\``),
    '',
    '## Merge by hand',
    '',
    mergeInto !== target ? `After review, merge into \`${mergeInto}\` (after the tickets before it, see index.md):` : 'After review:',
    '',
    '```bash',
    `git switch ${mergeInto}`,
    `git merge --no-ff ${source}`,
    '```',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

// index.md in the sprint's handoff folder: what to review, in which order, and the git commands.
function writeIndex(s) {
  const dir = handoffDir(s)
  const done = s.tickets.filter((t) => t.status === 'done')
  const rel = (f) => (f ? f.split(/[\\/]/).pop() : '')
  const rows = s.tickets.map((t, i) => `| ${i + 1} | ${t.id} | ${t.title} | ${t.status} | ${t.status === 'done' && t.handoff ? `\`${t.branch}\` → \`${t.parentBranch}\`` : t.status === 'blocked' ? `work kept on \`${t.branch}\`` : ''} | ${t.handoff ? `[${rel(t.handoff)}](${rel(t.handoff)})` : t.note || ''} |`)
  const lines = [
    `# Sprint ${s.sprint} handoff`,
    '',
    `Run status: **${s.status}**. Review mode: **${s.prMode}**. Base branch: \`${s.baseBranch}\`. Sprint branch: \`${s.sprintBranch}\`.`,
    '',
    '| # | Ticket | Title | Status | Branches | Details |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ]
  if (s.sprintHandoff) lines.push(`Sprint PR: [${rel(s.sprintHandoff)}](${rel(s.sprintHandoff)})`, '')
  if (done.length && !config.pushBranches) {
    lines.push('## Push the branches', '', 'The run did not push anything. To review on your git server:', '', '```bash', `git push -u ${config.remote} ${s.sprintBranch} ${s.prMode === 'chained' ? done.map((t) => t.branch).join(' ') : ''}`.trim(), '```', '')
  }
  if (done.length) {
    lines.push('## Merge order', '', s.prMode === 'chained' ? 'Each ticket branch contains the ones before it. Merge them in this order, each after its review:' : 'One review for the whole sprint:', '', '```bash')
    if (s.prMode === 'chained') {
      lines.push(`git switch ${s.sprintBranch}`)
      for (const t of done) lines.push(`git merge --no-ff ${t.branch}   # ${t.id}: ${t.title}`)
      lines.push('', '# when the sprint is approved')
    }
    lines.push(`git switch ${s.baseBranch}`, `git merge --no-ff ${s.sprintBranch}`, '```', '')
  }
  const file = join(dir, 'index.md')
  writeFileSync(file, lines.join('\n'))
  return file
}

function testsTouchedSinceRed(t) {
  if (!t.redCommit) return []
  return changedPathsSince(t.redCommit).filter((p) => isTestPath(p, config) && !p.startsWith(PROJECT_DIR_NAME + '/runs/'))
}

// Next workable ticket in order. Tickets whose dependencies ended blocked or skipped are skipped.
function pickNext(s) {
  for (const t of s.tickets) {
    if (t.status === 'in_progress') return t.id
    if (t.status !== 'todo') continue
    const deps = t.dependsOn.map((d) => s.tickets.find((x) => x.id === d)).filter(Boolean)
    const dead = deps.filter((d) => d.status === 'blocked' || d.status === 'skipped')
    if (dead.length) {
      t.status = 'skipped'
      t.note = `depends on ${dead.map((d) => `${d.id} (${d.status})`).join(', ')}`
      continue
    }
    if (deps.every((d) => d.status === 'done')) return t.id
  }
  return null
}

const fn = commands[command]
if (fn && !ROOT) fail('not inside a git repository.')
if (!fn) {
  ok(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
  process.exit(command ? 1 : 0)
}
try {
  fn()
} catch (err) {
  fail(err.stderr ? String(err.stderr).trim() : err.message)
}
