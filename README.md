# sprint-runner

A GitHub Copilot setup that runs a sprint of tickets unattended with strict TDD. For every ticket you get a reviewed, test-backed branch plus a ready PR title, markdown description and merge commands. It needs only git: no hosting service integration. You answer questions once at the start and review at the end. Set up once per user, used in any repository that opts in.

```
you ── pre-flight answers ──▶ sprint-runner (Opus, one session, one worktree)
                                 │  per ticket, in dependency order, each branch stacked on the last
                                 ├─ sprint-planner (Opus) ....... plan, Done-when → test table
                                 ├─ sprint-test-author (Sonnet) . RED: failing tests only
                                 ├─ sprint-verifier (Haiku) ..... proves RED, gates GREEN
                                 ├─ sprint-implementer (Sonnet) . GREEN → REFACTOR → FIX
                                 └─ sprint-reviewer ............. max 2 fix loops
you ◀── report + handoff files ──┘
```

## What is in this folder

`copilot-home/` mirrors your Copilot folder (`%USERPROFILE%\.copilot` on Windows, `~/.copilot` elsewhere). Setup is copying its contents there. [SETUP.md](SETUP.md) has the PowerShell commands, and [copilot-home/sprint-runner/HOOKS.md](copilot-home/sprint-runner/HOOKS.md) explains the hooks.

| Where | What | Who it affects |
|---|---|---|
| `~/.copilot/agents/` | `sprint-*.agent.md`, the six agents | You, in every repository |
| `~/.copilot/hooks/` | `sprint-runner.json`, registers the guard and the stop hook | You, in every Copilot session |
| `~/.copilot/sprint-runner/` | Scripts, default config and rubric, templates, your `settings.json`, `HOOKS.md` | Used by the two above |
| `.sprint-runner/` in a project | `config.json` (committed), optional `rubric.md` and `templates/` overrides (committed), `runs/` (git-ignored by its own `.gitignore`) | Everyone on that project |

### About the names

`~/.copilot/agents/` and `~/.copilot/hooks/` are folders Copilot itself reads. That is how the agents and hooks become available everywhere.

`.sprint-runner/` and `~/.copilot/sprint-runner/` are this kit's own names. No AI tool knows them. Only these agents and scripts read them, because their instructions say so. A dot-folder named after the tool follows the habit of `.vscode/` or `.husky/`: obvious ownership, out of the way, easy to delete.

The agents are prefixed `sprint-` on purpose. A user-level agent overrides a repository agent with the same file name, so a plain `planner.agent.md` here would silently replace a project's own planner.

## Set up a project (once per repository)

Open the repository in VS Code. In the Agents window, start a **Copilot** session with the `sprint-runner` agent and say `set up sprint-runner in this repo`. It runs `sprint-tool setup`, which writes `.sprint-runner/config.json` with your base branch and the test, lint and typecheck scripts it finds, then walks you through the rest:

- `ticketSource`: where the sprint's tickets come from. `type` is one of:
  - `markdown`: a board file (`board`) and ticket files (`ticketsGlob`)
  - `csv`: an export from Jira, Excel or any tracker at `csvPath`, with `csvColumns` naming the columns for id, title, description, status, sprint, dependencies and estimate. The defaults are Jira's export column names. Export from Excel with **Save As → CSV UTF-8**.
  - `paste`: you paste the tickets into the pre-flight chat
  - `mcp`: the tracker's MCP server named in `mcpServer`, filtered by `mcpQuery` (for example a JQL query). The server must be connected to Copilot, and `sprint-runner.agent.md` needs its tools added to the `tools:` line, for example `"jira/*"`.

  Whatever the source, pre-flight writes each ticket as a markdown snapshot in `.sprint-runner/runs/<sprint>/tickets/` and shows you anything it had to infer. The agents work from the snapshots only and never write back to the tracker.
- `specsDir`, `mockupsDir`: where specs and mockups live
- `checks` and `e2e`: the exact commands and the folder to run each in
- `testGlobs`: every path that counts as a test, fixture or golden file. The TDD lock trusts this list.
- `prMode`: `chained` (one PR per ticket, each built on the previous ticket's branch) or `single` (one PR per sprint)
- `pushBranches`: `false` by default, so the run never touches the remote and the handoff index lists the push command. Set `true` to let it push `sprint/*` and `ticket/*` branches.
- `handoffDir`: where handoff files go in the main worktree (default `.sprint-runner/handoff`, git-ignored)
- `protectedBranches`

The config is committed as the first commit of the first sprint, so it reaches the base branch through review like everything else.

## Run a sprint

1. Agents window, **Copilot** session target, **New Worktree** isolation.
2. Agent `sprint-runner`, session model Opus. Subagents cannot run on a more expensive model than the session.
3. A permission level that lets tools run without approval prompts. The hooks are the safety layer for that mode ([HOOKS.md](copilot-home/sprint-runner/HOOKS.md)).
4. `Run sprint 03`. Answer the pre-flight message in one reply, or `defaults`. Leave.
5. Back later: open `.sprint-runner/handoff/<sprint>/index.md` in your main worktree.

**First run**: watch once. The Agents window shows each subagent's model. Confirm they match the agent files, and that an attempt to edit code in RED shows a guard message.

## What you get back

In your main worktree (even though the run happened in a separate one), `.sprint-runner/handoff/<sprint>/` holds:

| File | Contents |
|---|---|
| `index.md` | Every ticket with its status, source → target branch and handoff file, then the push command and the merge order |
| `01-TEDI-017.md`, `02-...` | One per done ticket: PR title, source and target branch, size, the markdown description, the commit list, and the `git switch` / `git merge --no-ff` commands |
| `00-sprint.md` | The same for merging the sprint branch into the base branch |

In `chained` mode each ticket branch is built on the previous one, so its target branch is the previous ticket's branch and its diff shows only that ticket. Merge them into the sprint branch in the index's order, then the sprint branch into the base branch. Open the PRs in your review tool with the titles and descriptions from the files, or merge locally with the listed commands.

The folder ignores itself in git. The full run notes (plans, test reports, reviews) stay in the session worktree under `.sprint-runner/runs/<sprint>/`, with `report.md` as the summary.

## After your review

- **Review comments**: new session in the same worktree, `Address review on TEDI-018`, then paste the comments (or point it to a file with them). Attended, so it can ask you. It fixes the ticket, updates its handoff file, and merges the fix into every later ticket branch without rewriting history.
- **Status**: `Sprint status`.
- **Stalled run**: `Resume the sprint`.
- **Stop now**: `node "$HOME\.copilot\sprint-runner\bin\sprint-tool.mjs" abort "reason"` inside the repository.

## Settings

`~/.copilot/sprint-runner/settings.json`:

```json
{ "baseline": true }
```

`baseline` controls the guard's always-on tier in repositories without a sprint run. See [HOOKS.md](copilot-home/sprint-runner/HOOKS.md).

## Customizing

- **Rubric for one project**: copy `~/.copilot/sprint-runner/defaults/rubric.md` to the project's `.sprint-runner/rubric.md`.
- **Templates for one project**: copy `~/.copilot/sprint-runner/templates/` to `.sprint-runner/templates/`.
- **Agents, models or the default rubric for everyone**: edit them here, then copy them again (the update steps in SETUP.md). Edits made only in `~/.copilot` are lost on the next update.
- **Reviewer model**: `sprint-reviewer.agent.md` uses Opus. A model from another family gives a more independent review.

## Sharing with your team

Keep this folder in a git repository. Each person follows SETUP.md. The files use `$HOME` paths, so they work on every machine without edits.
