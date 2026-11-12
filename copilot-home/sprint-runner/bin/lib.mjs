// Shared helpers for the sprint-runner hooks and sprint-tool.
// Set up once per user. The project is found from the working directory,
// never from this file's location. No dependencies: Node 18+, Windows, macOS, Linux.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// <kit home>/bin -> <kit home>
export const KIT_HOME = resolve(here, '..')
export const SPRINT_TOOL = join(here, 'sprint-tool.mjs')
export const PROJECT_DIR_NAME = '.sprint-runner'

// ---------- project discovery ----------

export function findRepoRoot(start) {
  const dir = start && existsSync(start) ? start : process.cwd()
  const top = tryGit(['rev-parse', '--show-toplevel'], { cwd: dir })
  return top ? resolve(top) : null
}

export function projectPaths(root) {
  const dir = join(root, PROJECT_DIR_NAME)
  const runs = join(dir, 'runs')
  const ownRubric = join(dir, 'rubric.md')
  const ownTemplates = join(dir, 'templates')
  return {
    repoRoot: root,
    projectDir: dir,
    config: join(dir, 'config.json'),
    runs,
    state: join(runs, 'state.json'),
    rubric: existsSync(ownRubric) ? ownRubric : join(KIT_HOME, 'defaults', 'rubric.md'),
    templates: existsSync(ownTemplates) ? ownTemplates : join(KIT_HOME, 'templates'),
    kitHome: KIT_HOME,
    sprintTool: SPRINT_TOOL,
  }
}

// The repository's main worktree: the folder you normally have open, even when this
// session runs in a separate worktree. Handoff files are written there so you find them.
export function mainWorktree(root) {
  const out = tryGit(['worktree', 'list', '--porcelain'], { cwd: root })
  const first = (out || '').split('\n').find((l) => l.startsWith('worktree '))
  return first ? resolve(first.slice('worktree '.length).trim()) : root
}

export function defaultConfig() {
  return JSON.parse(readFileSync(join(KIT_HOME, 'defaults', 'config.json'), 'utf8'))
}

// Returns the merged config and whether the project opted in with its own config file.
export function loadConfig(root) {
  const base = defaultConfig()
  if (!root) return { ...base, optedIn: false }
  const file = projectPaths(root).config
  if (!existsSync(file)) return { ...base, optedIn: false }
  return { ...base, ...JSON.parse(readFileSync(file, 'utf8')), optedIn: true }
}

export function loadState(root) {
  if (!root) return null
  const file = projectPaths(root).state
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// runs/ holds per-machine run state and notes. A .gitignore containing "*" inside it
// keeps everything there out of git without touching the repository's own .gitignore.
export function ensureRunsDir(root) {
  const { runs } = projectPaths(root)
  mkdirSync(runs, { recursive: true })
  const ignore = join(runs, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return runs
}

export function saveState(root, state) {
  ensureRunsDir(root)
  const file = projectPaths(root).state
  state.updatedAt = new Date().toISOString()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  renameSync(tmp, file)
}

// ---------- paths and globs ----------

const WIN_DRIVE = /^[a-zA-Z]:[\\/]/

// Path relative to the repo root with forward slashes, or an absolute path when it is outside.
export function toRepoPath(p, cwd, root) {
  if (typeof p !== 'string' || p.length === 0) return null
  let s = p.trim().replace(/^["']|["']$/g, '')
  if (s.startsWith('file://')) s = fileURLToPath(s)
  if (WIN_DRIVE.test(s) && sep === '/') return s.replace(/\\/g, '/')
  if (sep === '/') s = s.replace(/\\/g, '/')
  if (!root) return isAbsolute(s) ? s.split(sep).join('/') : s
  const abs = isAbsolute(s) ? s : resolve(cwd || root, s)
  return relative(root, abs).split(sep).join('/')
}

export function isOutsideRepo(repoPath) {
  return repoPath === null || repoPath === '..' || repoPath.startsWith('../') || isAbsolute(repoPath) || /^[a-zA-Z]:\//.test(repoPath) || repoPath.startsWith('/')
}

const globCache = new Map()
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob)
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  const out = new RegExp('^' + re + '$', 'i')
  globCache.set(glob, out)
  return out
}

export function matchesAny(repoPath, globs) {
  if (!repoPath || !Array.isArray(globs)) return false
  return globs.some((g) => globToRegExp(g).test(repoPath))
}

export function isTestPath(repoPath, config) {
  return matchesAny(repoPath, config.testGlobs)
}

export function isProtectedBranch(name, config) {
  if (!name) return false
  return matchesAny(name.replace(/^refs\/heads\//, ''), config.protectedBranches)
}

// ---------- git ----------

export function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function tryGit(args, opts = {}) {
  try {
    return git(args, opts)
  } catch {
    return null
  }
}

export function currentBranch(cwd) {
  return tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}

// Every path that differs from `base`: committed, staged, unstaged and untracked.
export function changedPathsSince(base, root) {
  const out = new Set()
  const add = (txt) =>
    (txt || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l) => out.add(l.replace(/\\/g, '/')))
  add(tryGit(['diff', '--name-only', `${base}...HEAD`], { cwd: root }))
  add(tryGit(['diff', '--name-only', 'HEAD'], { cwd: root }))
  add(tryGit(['ls-files', '--others', '--exclude-standard'], { cwd: root }))
  return [...out]
}

// ---------- hook I/O ----------

export function readStdinJson() {
  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    return {}
  }
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

// Normalizes the fields the Copilot runtime sends (camelCase) and the Claude-style
// fields some sources use (snake_case).
export function readHookEvent() {
  const event = readStdinJson()
  let args = event.toolArgs ?? event.tool_input ?? {}
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = { command: args }
    }
  }
  const cwd = event.cwd || process.cwd()
  return {
    raw: event,
    toolName: String(event.toolName ?? event.tool_name ?? ''),
    args: args && typeof args === 'object' ? args : {},
    cwd,
    root: findRepoRoot(cwd),
    isSubagent: Boolean(event.agentId ?? event.agent_id ?? event.parentAgentId ?? event.parent_agent_id),
    agentType: String(event.agentType ?? event.agent_type ?? event.agentName ?? event.agent_name ?? ''),
  }
}

export function respond(obj) {
  process.stdout.write(JSON.stringify(obj || {}))
}

export function deny(reason) {
  respond({ permissionDecision: 'deny', permissionDecisionReason: reason })
}

export const EDIT_TOOL = /^(edit|create|write|str_replace_editor|str_replace_based_edit_tool|apply_patch|multi_edit|multiedit|insert|notebook_edit|editfiles|edit_file|create_file|replace_string_in_file|insert_edit_into_file)$/i

export function extractEditPaths(args) {
  const paths = []
  if (!args || typeof args !== 'object') return paths
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file', 'target_file', 'notebook_path']) {
    if (typeof args[key] === 'string') paths.push(args[key])
  }
  for (const key of ['paths', 'files', 'filePaths']) {
    if (Array.isArray(args[key])) args[key].forEach((p) => typeof p === 'string' && paths.push(p))
  }
  if (Array.isArray(args.edits)) args.edits.forEach((e) => e && typeof e.path === 'string' && paths.push(e.path))
  for (const key of ['patch', 'input', 'diff']) {
    if (typeof args[key] === 'string') {
      for (const m of args[key].matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(m[1].trim())
      for (const m of args[key].matchAll(/^\*\*\* Move to: (.+)$/gm)) paths.push(m[1].trim())
      for (const m of args[key].matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)) if (m[1] !== '/dev/null') paths.push(m[1].trim())
    }
  }
  return paths
}
