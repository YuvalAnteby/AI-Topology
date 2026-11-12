// agentStop hook. Runs when the main agent is about to end its turn, in every session.
// Outside an unattended sprint run it does nothing. During a run it sends the agent back
// to work while tickets are open, and gives up after three nudges with no progress
// (the run is then marked "stalled"), so it can never loop forever.
import { loadState, saveState, readHookEvent, respond, SPRINT_TOOL } from './lib.mjs'

const MAX_IDLE_NUDGES = 3

function main() {
  const { root } = readHookEvent()
  const s = loadState(root)
  if (!s || s.status !== 'running') return respond({})

  const open = s.tickets.filter((t) => t.status === 'todo' || t.status === 'in_progress')
  const signature = JSON.stringify([s.tickets.map((t) => t.status), s.current])
  s.stopBlocks = signature === s.lastStopSignature ? (s.stopBlocks || 0) + 1 : 1
  s.lastStopSignature = signature

  if (s.stopBlocks > MAX_IDLE_NUDGES) {
    s.status = 'stalled'
    s.note = `Stopped after ${MAX_IDLE_NUDGES} nudges without progress${s.current ? ` at ${s.current.ticket} (${s.current.phase})` : ''}.`
    saveState(root, s)
    return respond({})
  }
  saveState(root, s)

  const tool = `node "${SPRINT_TOOL.replace(/\\/g, '/')}"`
  if (open.length) {
    const cur = s.current && s.current.phase !== 'idle' ? `You are in ${s.current.ticket}, phase ${s.current.phase.toUpperCase()}. ` : ''
    return respond({
      decision: 'block',
      reason:
        `The sprint run for ${s.sprint} is not finished: ${open.map((t) => t.id).join(', ')} still open. ${cur}` +
        'Nobody is watching, so do not stop to ask. Continue the per-ticket loop from your instructions. ' +
        `If the current ticket cannot continue, run ${tool} block <ticket> "<reason>" and then ${tool} next.`,
    })
  }
  return respond({
    decision: 'block',
    reason: `Every ticket in ${s.sprint} is done, blocked or skipped. Write the run report from the report template, then run ${tool} finish.`,
  })
}

try {
  main()
} catch {
  respond({})
}
