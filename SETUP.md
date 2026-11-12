# Setup (manual, per user)

Everything is copying files into your Copilot folder and checking that they work. There is nothing to install and no script that changes your system. Run the commands in your own PowerShell window, not through an agent.

## 0. Check the tools

```powershell
node --version   # 18 or newer
git --version
```

`node` must be on `PATH` for VS Code too. If you just installed Node, restart VS Code.

## 1. Point two variables at the kit and at your Copilot folder

```powershell
$Kit = "$HOME\Downloads\sprint-runner"          # where you unzipped this kit
$CopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { "$HOME\.copilot" }
$CopilotHome
```

## 2. Check for name clashes

```powershell
Get-ChildItem "$CopilotHome\agents\sprint-*.agent.md" -ErrorAction SilentlyContinue
Test-Path "$CopilotHome\hooks\sprint-runner.json"
```

Both should come back empty or `False`. If not, those files are from something else. Rename yours or stop here.

## 3. Copy the files

```powershell
New-Item -ItemType Directory -Force "$CopilotHome\agents", "$CopilotHome\hooks", "$CopilotHome\sprint-runner" | Out-Null
Copy-Item "$Kit\copilot-home\agents\*" "$CopilotHome\agents\"
Copy-Item "$Kit\copilot-home\hooks\sprint-runner.json" "$CopilotHome\hooks\"
Copy-Item "$Kit\copilot-home\sprint-runner\*" "$CopilotHome\sprint-runner\" -Recurse
```

Result:

```
<Copilot folder>
├─ agents\    sprint-runner, sprint-planner, sprint-test-author, sprint-implementer, sprint-verifier, sprint-reviewer (.agent.md)
├─ hooks\     sprint-runner.json
└─ sprint-runner\
   ├─ bin\        guard, stop hook, read-only hook, sprint-tool, self-test
   ├─ defaults\   config.json, rubric.md
   ├─ templates\  preflight, decisions, plan, pr, report
   ├─ settings.json
   └─ HOOKS.md
```

The agent and hook files find the scripts through `$HOME\.copilot\...`. If your Copilot folder is somewhere else (`COPILOT_HOME` is set), do step 5 now.

## 4. Verify

**a. The scripts work on this machine.** Runs every rule against a throwaway repository in your temp folder:

```powershell
node "$CopilotHome\sprint-runner\bin\selftest.mjs"
```

Expect `sprint-runner self-test: N/N passed`.

**b. The guard answers by hand.** From inside any git repository:

```powershell
'{"toolName":"bash","toolArgs":{"command":"git push --force --dry-run"}}' | node "$CopilotHome\sprint-runner\bin\guard.mjs"
'{"toolName":"bash","toolArgs":{"command":"git status"}}' | node "$CopilotHome\sprint-runner\bin\guard.mjs"
```

The first prints a `deny` with a reason, the second prints `{}`.

**c. Copilot runs the hook.** Restart VS Code. In the Agents window, start a session with the **Copilot** session target, in any repository, and ask: `run git push --force --dry-run in the terminal`. You should see the guard's message instead of git output. `--dry-run` means nothing is pushed even if the hook does not fire.

**d. The agents are visible.** In that session's agent picker you should see `sprint-runner`, `sprint-planner` and `sprint-reviewer`. The other three are subagents only and are hidden from the picker.

**e. The scoped read-only hook works.** Start a session with `sprint-reviewer` and ask: `create a file notes.txt containing hello`. It should be blocked with "This agent is read-only".

If c or e fails while a and b pass, the hook command probably did not expand `$HOME`. Do step 5.

## 5. Only if needed: use literal paths

Replaces `$HOME/.copilot` in the agent and hook files with your actual Copilot folder. Use it when `COPILOT_HOME` is set, or when verification step c or e failed.

```powershell
$fwd = $CopilotHome -replace '\\', '/'
$utf8 = New-Object System.Text.UTF8Encoding $false
$files = @(Get-ChildItem "$CopilotHome\agents\sprint-*.agent.md") + @(Get-Item "$CopilotHome\hooks\sprint-runner.json")
foreach ($f in $files) {
  $t = [IO.File]::ReadAllText($f.FullName)
  $t = $t.Replace('$HOME/.copilot', $fwd).Replace('$HOME\\.copilot', $fwd).Replace('$HOME\.copilot', $fwd)
  [IO.File]::WriteAllText($f.FullName, $t, $utf8)
}
Select-String -Path $files -Pattern '\$HOME' -CaseSensitive   # should print nothing
```

Then repeat step 4.

## 6. Set up a project

Once per repository. In a Copilot session with the `sprint-runner` agent, say `set up sprint-runner in this repo`. Or run it yourself from the repository folder:

```powershell
node "$CopilotHome\sprint-runner\bin\sprint-tool.mjs" setup
```

It creates `.sprint-runner\config.json` with your base branch and the test, lint and typecheck scripts it finds in `package.json` files. Fill in `ticketSource` (markdown files, a CSV export, pasted tickets or an MCP server) and check the commands. See `README.md` for every field.

If you copied the earlier per-repository version of this kit into a project, delete its `.github\hooks\sprint-guard.json`, `.github\hooks\scripts\` and its agent files there. Hooks from all locations run together, so both guards would fire.

## Update to a new version

Unzip the new kit, set `$Kit` and `$CopilotHome` again, then:

```powershell
Copy-Item "$Kit\copilot-home\agents\*" "$CopilotHome\agents\" -Force
Copy-Item "$Kit\copilot-home\hooks\sprint-runner.json" "$CopilotHome\hooks\" -Force
foreach ($d in 'bin', 'defaults', 'templates') {
  Remove-Item "$CopilotHome\sprint-runner\$d" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item "$Kit\copilot-home\sprint-runner\$d" "$CopilotHome\sprint-runner\" -Recurse
}
Copy-Item "$Kit\copilot-home\sprint-runner\HOOKS.md" "$CopilotHome\sprint-runner\" -Force
node "$CopilotHome\sprint-runner\bin\selftest.mjs"
```

Your `settings.json` is not touched. Repeat step 5 if you used it before.

## Switch off or remove

```powershell
# pause every hook (agents stay)
Rename-Item "$CopilotHome\hooks\sprint-runner.json" "sprint-runner.json.off"

# remove everything (project .sprint-runner folders stay)
Remove-Item "$CopilotHome\agents\sprint-*.agent.md"
Remove-Item "$CopilotHome\hooks\sprint-runner.json*"
Remove-Item "$CopilotHome\sprint-runner" -Recurse -Force
```

## macOS and Linux

Same steps in bash:

```bash
KIT=~/Downloads/sprint-runner
CH="${COPILOT_HOME:-$HOME/.copilot}"
mkdir -p "$CH/agents" "$CH/hooks" "$CH/sprint-runner"
cp "$KIT"/copilot-home/agents/* "$CH/agents/"
cp "$KIT"/copilot-home/hooks/sprint-runner.json "$CH/hooks/"
cp -R "$KIT"/copilot-home/sprint-runner/. "$CH/sprint-runner/"
node "$CH/sprint-runner/bin/selftest.mjs"
```
