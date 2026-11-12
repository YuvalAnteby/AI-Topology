// Agent-scoped preToolUse hook for sprint-verifier and sprint-reviewer, declared in their
// frontmatter, so it only runs while one of them is working. They may write their
// reports under .sprint-runner/runs/ and nothing else.
import { readHookEvent, respond, deny, toRepoPath, EDIT_TOOL, extractEditPaths, PROJECT_DIR_NAME } from './lib.mjs'

try {
  const { toolName, args, cwd, root } = readHookEvent()
  if (!EDIT_TOOL.test(toolName)) {
    respond({})
  } else {
    const paths = extractEditPaths(args).map((p) => toRepoPath(p, cwd, root))
    const prefix = `${PROJECT_DIR_NAME}/runs/`
    const bad = paths.filter((p) => !p || !p.startsWith(prefix) || p.endsWith('state.json'))
    if (paths.length === 0 || bad.length) {
      deny(`This agent is read-only. It may only write its report under ${prefix}. Blocked: ${bad.join(', ') || 'unknown path'}.`)
    } else {
      respond({})
    }
  }
} catch (err) {
  deny(`Read-only hook error: ${err && err.message}`)
}
