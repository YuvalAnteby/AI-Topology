# How the hooks work

## What a hook is

A hook is a small program that Copilot runs at fixed moments of a session, the same idea as a git `pre-commit` hook. At that moment the Copilot runtime pauses, sends your program a JSON description of what is about to happen, and reads a JSON answer back. The answer can let things continue, or stop them with a reason.

The model never sees or runs the hook. It only sees the outcome. That is the point: a rule in a prompt is a request the model usually follows, while a rule in a hook is enforced every time.

```
 agent decides to run "git push --force"
          │
          ▼
 Copilot runtime ──stdin: {"toolName":"bash","toolArgs":{"command":"git push --force"},"cwd":"..."}──▶ guard.mjs
          ▲                                                                                          │
          └──stdout: {"permissionDecision":"deny","permissionDecisionReason":"git push: force ..."}◀──┘
          │
          ▼
 the command never runs, and the agent gets the reason back and adapts
```

## The two moments this kit uses

| Event | When it fires | What our answer can do |
|---|---|---|
| `preToolUse` | Before every tool call: a shell command, a file edit, a question to the user | Return `{}` to allow it, or `{"permissionDecision":"deny","permissionDecisionReason":"..."}` to block it. The reason goes back to the agent so it can adapt. |
| `agentStop` | When the main agent is about to end its turn | Return `{}` to let it stop, or `{"decision":"block","reason":"..."}` to make it keep working, with the reason as its next instruction. |

Copilot has more events (session start, prompt submitted, after a tool call, subagent start and stop, errors). This kit does not use them.

## Where hook files live

A hook file is JSON that says which program runs on which event. Copilot reads several places and **runs all of them together**. A hook in one place never replaces a hook in another.

| Location | Applies to |
|---|---|
| `~/.copilot/hooks/*.json` (Windows: `%USERPROFILE%\.copilot\hooks\`) | Every Copilot session of this user, in every repository. This kit's `sprint-runner.json` goes here. |
| `.github/hooks/*.json` in a repository | Sessions in that repository, for everyone who clones it |
| `hooks:` in an agent file's frontmatter | Only while that agent is working |
| Plugins and organization policy folders | Whatever installed them |

`COPILOT_HOME`, when set, replaces `~/.copilot` in the first row.

The kit's hook file, `~/.copilot/hooks/sprint-runner.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "node \"$HOME/.copilot/sprint-runner/bin/guard.mjs\"",
        "powershell": "node \"$HOME\\.copilot\\sprint-runner\\bin\\guard.mjs\"",
        "timeoutSec": 15
      }
    ],
    "agentStop": [ "...the same shape, running continue-sprint.mjs..." ]
  }
}
```

`powershell` is used on Windows, `bash` on macOS and Linux. Both find the scripts through `$HOME`, which both shells expand, and both need `node` on `PATH`. The backslashes are doubled because this is JSON. In PowerShell the command reads `node "$HOME\.copilot\sprint-runner\bin\guard.mjs"`.

## The three hooks in this kit

### `guard.mjs` (preToolUse, every session)

It finds the repository from the `cwd` in the payload, then applies two tiers.

**Baseline, in every repository and outside any repository.** Blocks commands that destroy work or data and are hard to undo:
force, mirror and delete pushes, `reset --hard`, `clean -f`, `checkout -- .` and `restore .`, `branch -D`, `stash drop`, history rewriting tools, dropping or truncating database tables, `prisma migrate reset`, `schema:drop`, `docker compose down -v`, piping a download into a shell, and recursive deletes of anything except build output inside the repository (`node_modules`, `dist`, `build`, `coverage` and similar).
Normal work is untouched: pushing to `main`, committing on `dev`, rebasing and merging all stay allowed outside a sprint run.
Turn this tier off with `"baseline": false` in `~/.copilot/sprint-runner/settings.json`.

**Run, only in a repository whose sprint run is in progress.** Adds the sprint's rules:
- no pushes at all unless the project sets `pushBranches: true`, and then only `sprint/*` and `ticket/*` branches
- no merging into the sprint branch (that is your step after review), no commits on protected branches, no rebase, no `--no-verify`
- the TDD phase lock: in RED only test files can be edited, in GREEN, REFACTOR and FIX test files are frozen, in PLAN and REVIEW no code changes at all
- the agents, hooks, kit scripts, project config, rubric, ticket snapshots, handoff files and run state are locked. Handoff files are written only by `sprint-tool handoff`.
- only the main agent (sprint-runner) can change run state through `sprint-tool`. The guard recognizes subagents by the `agentId` field the runtime adds to their tool calls.
- during the unattended part of a run, questions to the user are blocked, so the run never waits for someone who is not there

It also enforces, in every session, that the sprint-verifier and sprint-reviewer agents only write their reports. It recognizes them by the agent type field when the runtime sends it.

### `continue-sprint.mjs` (agentStop, every session)

Does nothing unless this repository has an unattended run in progress. During a run, when the main agent tries to end its turn while tickets are still open, it answers `block` with an instruction to continue the loop or block the ticket. After three attempts in a row with no progress, it lets the agent stop and marks the run `stalled`, so it can never loop forever. `Resume the sprint` picks it up again.

### `readonly-except-runs.mjs` (preToolUse, scoped to two agents)

Declared in the frontmatter of `sprint-verifier` and `sprint-reviewer`, so it only runs while one of them is working. It blocks every file edit except their own report under `.sprint-runner/runs/`. The guard repeats this rule as a second line of defense.

### `sprint-tool.mjs` is not a hook

It is a command-line tool the sprint-runner agent calls (`node .../sprint-tool.mjs begin TEDI-018`). It owns the run state, creates and switches branches, and makes every commit. It also checks git itself: it refuses to commit tests that were edited after the RED commit, even when the edit happened through a shell command the guard could not see. The hooks make sure the agent goes through it.

## How they fail

- **A hook that crashes blocks the tool call** (it fails closed). Every script catches its own errors and answers with a readable reason instead.
- **A hook that takes longer than `timeoutSec` (15 seconds) lets the call through** (it fails open). The guard answers in well under a second, mostly the time to start Node and ask git for the current branch.

## Try them by hand

From inside any git repository. Bash:

```bash
echo '{"toolName":"bash","toolArgs":{"command":"git push --force"}}' | node ~/.copilot/sprint-runner/bin/guard.mjs
echo '{"toolName":"bash","toolArgs":{"command":"git status"}}' | node ~/.copilot/sprint-runner/bin/guard.mjs
```

PowerShell:

```powershell
'{"toolName":"bash","toolArgs":{"command":"git push --force"}}' | node "$HOME\.copilot\sprint-runner\bin\guard.mjs"
```

The first prints a deny with its reason, the second prints `{}`.

Run every rule against a throwaway repository: `node ~/.copilot/sprint-runner/bin/selftest.mjs`.

## Turning things off

| To | Do |
|---|---|
| Stop a run and lift its locks now | `node ~/.copilot/sprint-runner/bin/sprint-tool.mjs abort "reason"` inside the repository |
| Keep sprint runs, drop the baseline in other repositories | `"baseline": false` in `~/.copilot/sprint-runner/settings.json` |
| Disable every hook for a while | Move `~/.copilot/hooks/sprint-runner.json` out of the folder |
| Remove everything | "Switch off or remove" in `SETUP.md` |

## Limits worth knowing

- The guard reads shell commands as text. It handles chains (`&&`, `;`, `|`), quotes and nested `sh -c` or `pwsh -Command`, but a command hidden inside a script file is invisible to it. The git checks in `sprint-tool` and your PR review are the backstop for code. For destructive commands, treat the baseline as a strong seatbelt, not a sandbox.
- Some payload details are not fully documented yet: whether every runtime sends `agentType` for subagents, and whether user-level agents run their frontmatter hooks inside VS Code. The kit has a second check for each, and the self-test covers both payload styles.
