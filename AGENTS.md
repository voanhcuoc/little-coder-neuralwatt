# AGENTS.md — Behavioral notes for little-coder on this machine

This file documents operational quirks of little-coder / pi that affect how the
agent should behave when working in this directory. The agent reads this at
startup alongside README.md.

## Permission gate

little-coder gates shell commands through the `permission-gate` extension
(`.pi/extensions/permission-gate/index.ts`). Three modes, controlled by
`LITTLE_CODER_PERMISSION_MODE`:

### Modes

| Mode | Env var | Behavior |
|---|---|---|
| `auto` (default) | not set, or `=auto` | Whitelist: commands matching `BUILTIN_SAFE_PREFIXES` pass silently; everything else blocked |
| `manual` | `=manual` | Every shell command prompts the user before execution (no whitelist) |
| `accept-all` | `=accept-all` | No gate — all commands pass silently |

This machine is set to `manual` (persistent fish universal var: `set -Ux
LITTLE_CODER_PERMISSION_MODE manual`). Every `bash`/`ShellSession`/`ShellStart`
tool call will trigger a TUI confirm dialog.

### Whitelist (`auto` mode reference)

When in `auto` mode, these commands pass:

```
ls cat head tail wc pwd echo printf date which type env printenv uname whoami id
git log git status git diff git show git branch git remote git stash list git tag
find grep rg ag fd sed
python python3 node ruby perl
pip show pip list npm list cargo metadata
df du free top -bn ps
curl -I curl --head
cp mv mkdir touch
```

**Always blocked regardless of prefix:** any command with shell redirection
(`>`, `>>`), `tee`, or `dd of=` — writes must go through the `write`/`edit`
tools instead.

**`rm` is off the whitelist by design.** Use `LITTLE_CODER_BASH_ALLOW=rm` to add
it, or switch to `manual` mode.

### Adding commands in `auto` mode

Set `LITTLE_CODER_BASH_ALLOW` (comma-separated, merges with builtins):

```fish
set -Ux LITTLE_CODER_BASH_ALLOW "rm,make,cargo,docker,go,nix"
```

### When a command is blocked

The agent receives a structured error with the refused binary name and
instructions. **Do not** retry the same command through a different interpreter
(`python3 -c`, `node -e`, `sh -c`, `find -exec`) — this defeats a limit the user
set on purpose, wastes turns, and the gate catches all shell-executing tools
(`bash`, `Bash`, `ShellSession`, `ShellStart`) per issue #70.

If a file needs changing, use `edit` or `write`, which don't need a shell.
Otherwise, tell the user the command was refused and that they can allow it
with `LITTLE_CODER_BASH_ALLOW="<binary>"` or `LITTLE_CODER_PERMISSION_MODE=accept-all`.

## Canceling the agent loop (Esc / Ctrl-C)

### Known limitation

Esc only aborts the **current LLM streaming call** or **running bash command** —
not the agent loop as a whole. After abort, the agent loop (`_handlePostAgentRun`
→ `agent.continue()`) may continue if:

- The model had already produced tool calls before Esc was pressed
- A blocked tool result (e.g. "No" in manual mode) goes back to the model,
  which starts a new streaming call to decide what to do next
- Queued steering/follow-up messages remain

This is a known architectural issue, tracked in:

- [pi #5177](https://github.com/earendil-works/pi/issues/5177) — Esc/Ctrl-C
  sometimes cannot stop the model; model continues thinking and running tools
  after abort
- [little-coder #114](https://github.com/itayinbarr/little-coder/issues/114) —
  Esc unable to stop agent during compaction/loop; `/quit` + resume fixes it
- [pi #2716](https://github.com/earendil-works/pi/issues/2716) — Escape
  triggering abort during bash can crash with unhandled `AbortError`
- [pi #4118](https://github.com/earendil-works/pi/issues/4118) — Request for
  `stopAfterTurn()` (graceful stop after current turn, not mid-stream);
  **closed as not planned**
- [pi #3344](https://github.com/earendil-works/pi/issues/3344) — Aborted tool
  calls can corrupt conversation state (orphaned `tool_use` blocks)

### Keybindings

| Key | Action | What it does |
|---|---|---|
| **Esc** | `app.interrupt` | Aborts current LLM streaming call or bash execution |
| **Ctrl-C** | `app.clear` | Clears the editor text input — does NOT abort the agent |
| **Ctrl-D** | `app.exit` | Exits the app (only when editor is empty) |
| **Ctrl-Z** | `app.suspend` | Suspends process to background (`SIGTSTP`) |

**Ctrl-C does not abort the agent.** It clears the editor. This is a common
source of confusion.

### How Esc branches (source: `interactive-mode.js` L2015-2021)

```
onEscape:
  if session.isStreaming     → restoreQueuedMessagesToEditor({ abort: true })  // abort LLM
  else if session.isBashRunning → session.abortBash()                          // kill bash
  else if isBashMode          → editor.setText("")                            // clear input
```

### Reliable workaround

When the agent won't stop:

```
/quit              # exits the TUI cleanly (preserves session)
little-coder -c    # resume the session (--continue)
```

During auto-retry backoff, Esc cancels the retry delay (via
`this.session.abortRetry()`). During compaction, Esc cancels compaction (via
`this.session.abortCompaction()`). These are separate Escape handlers that
temporarily replace the default one.

### The `manual` permission interaction

In `manual` mode, selecting "No" on a permission prompt blocks the tool call
(`{ block: true }`), but the blocked result goes back to the model as a tool
error. The agent loop continues — the model gets the blocked result, makes
another LLM call, and starts streaming again. This can create a loop that's
hard to interrupt with Esc, because the window between the block and the next
streaming call is very short.

If this happens, use `/quit` + resume.

## Headless mode default model

`little-coder -p` (print/headless mode) does **not** inject the configured
default model — `decideDefaultModel` returns `null` when `headless` is true
(by design: "sub-coders / --mode runs control their own model"). Always pass
`--model neuralwatt/qwen3.6-35b` explicitly in headless mode:

```bash
little-coder --no-tools --model neuralwatt/qwen3.6-35b -p "your prompt"
```

Bare interactive `little-coder` (no flags) does inject the default — the
neuralwatt model is selected automatically on first run (before pi persists a
user's in-session selection).

## Auto-retry

On transient errors (overloaded, rate limit, 5xx, connection drops), pi
auto-retries with exponential backoff (default: 3 attempts, 2s/4s/8s). During
retry delay, a `RetryStatusIndicator` shows in the TUI with
"(Esc to cancel)". Esc during retry cancels the retry.

Retry is **not** triggered by:
- Context overflow (handled by compaction instead)
- Non-retryable errors (400 Bad Request, 401 Auth, etc.)

Settings are in `~/.pi/agent/settings.json` under the `retry` key.
Toggle at runtime: `session.setAutoRetryEnabled(true/false)`.

## pi extensions not loaded by default

little-coder does NOT auto-load pi ecosystem extensions
(`--no-extensions` is the default). This is a deliberate design choice for
small models: extensions add cold-start context, and predictability ("exactly
this set loads") is valued over ecosystem integration.

To load pi extensions:
- Pass `--with-pi-extensions` on the CLI, or
- Set `LITTLE_CODER_PI_EXTENSIONS=1`, or
- Drop extension `.ts` files in `~/.config/little-coder/extensions/`
  (always loaded, survives `npm install -g little-coder@latest`)

## KWallet API key retrieval

The `apiKey` field in `models.json` is:
```
!kwallet-query -f Passwords -r neuralwatt-api-key kdewallet
```

pi's `resolve-config-value.js` runs this command via `/bin/sh -c` at request
time (cached for the process lifetime). The command's stdout (trimmed) becomes
the Bearer token. If `kwallet-query` exits non-zero (e.g. entry missing,
wallet closed, DBUS unavailable), pi throws "Failed to resolve API key" — a
clean error, not a garbage-key attempt.

**Requirement:** `DBUS_SESSION_BUS_ADDRESS` must be set. Normal desktop login
provides this. Headless/systemd/cron launches may not — in those cases, use an
env-var key (`$NEURALWATT_API_KEY`) instead.
