# AGENTS.md — Neuralwatt provider for little-coder

Full technical reference for setting up little-coder with the Neuralwatt
provider. An AI agent reading this should be able to reproduce the full config,
understand every field's provenance, and adapt it to a different environment.

## Overview

[little-coder](https://www.npmjs.com/package/little-coder) ships with
`llamacpp/qwen3.6-35b-a3b` (a local llama.cpp model) as its default. This
config replaces that with `neuralwatt/qwen3.6-35b` — the same model family
hosted on Neuralwatt's OpenAI-compatible API — and sets it as the default.

The override file (`models.json`) is copied to
`~/.config/little-coder/models.json`. little-coder's `llama-cpp-provider`
extension reads it at startup and registers providers via pi's
`registerProvider()`.

## Override file resolution

little-coder resolves the user override file (first match wins):

1. `$LITTLE_CODER_MODELS_FILE` — explicit path
2. `$XDG_CONFIG_HOME/little-coder/models.json`
3. `~/.config/little-coder/models.json`

Merge semantics: each top-level provider key in the override **fully replaces**
the same key in the shipped `models.json`. Providers only in the override are
added; providers only in the shipped file are kept. No deep per-model merging —
the whole provider entry is redeclared.

The `default` key is first-run-only: once you switch models in an interactive
session, pi persists the selection (`defaultProvider` + `defaultModel` in
`~/.pi/agent/settings.json`) and the default stops applying. In headless
(`-p`/`--print`) mode, `decideDefaultModel` returns `null` (by design:
"sub-coders / --mode runs control their own model") — always pass `--model`
explicitly in headless mode.

## Configuration values

All values sourced from Neuralwatt's live API
(`GET https://api.neuralwatt.com/v1/models`, no auth required for the catalog):

| Field | Value | Source |
|---|---|---|
| `baseUrl` | `https://api.neuralwatt.com/v1` | [API docs](https://portal.neuralwatt.com/docs/api/overview) |
| `id` | `qwen3.6-35b` | API `/v1/models` → `id` field |
| `contextWindow` | `131056` | API `max_model_len` (not the rounded 131072) |
| `maxTokens` | `32768` | API reports `max_output_tokens: null` (no cap); matches pi-neuralwatt's `DEFAULT_MAX_OUTPUT_TOKENS` fallback |
| `reasoning` | `true` | API `capabilities.reasoning: true` |
| `input` | `["text", "image"]` | API `capabilities.vision: true` |
| `cost.input` | `0.29` | API `pricing.input_per_million` (USD/M tokens) |
| `cost.output` | `1.15` | API `pricing.output_per_million` |
| `cost.cacheRead` | `0.029` | API `pricing.cached_input_per_million` |
| `cost.cacheWrite` | `0` | API reports `cached_output_per_million: null` → 0 |

### `thinkingLevelMap`

Synthesized from the API's `reasoning` config, not copied from pi-neuralwatt
(which leaves it `undefined` for this model — `buildEffortMapIndex` only returns
a map when a non-neuralwatt built-in model shares the same id, and pi ships no
`qwen3.6-35b` in its built-in catalog). The API supports only two effective
effort levels: `high` and `none`, with effort aliases mapping everything else to
`high`.

| pi level | sends to API | rationale |
|---|---|---|
| `off` | `reasoning_effort: "none"` | **Critical:** without this mapping, `off` → pi sends no `reasoning_effort` → API defaults to `high` → thinking stays ON silently |
| `minimal` | `reasoning_effort: "high"` | API aliases minimal→high; explicit is semantically correct |
| `low` | `reasoning_effort: "high"` | Same alias |
| `medium` | `reasoning_effort: "high"` | Same alias |
| `high` | `reasoning_effort: "high"` | Passthrough |
| `xhigh` | absent | `getSupportedThinkingLevels` hides levels not in the map (L399: `return mapped !== undefined`); model has no distinct xhigh |
| `max` | absent | Same — no distinct max level |

#### Request path (source: `openai-completions.js` L638-647)

Provider `neuralwatt` matches no special detection pattern in `detectCompat`,
so `thinkingFormat` auto-detects to `"openai"` (the standard
`reasoning_effort` path):

```js
// When thinking is ON:
params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
// When thinking is OFF:
const offValue = model.thinkingLevelMap?.off;
if (typeof offValue === "string") {
    params.reasoning_effort = offValue;  // sends "none" → API disables reasoning
}
// else: NO reasoning_effort sent → API defaults to "high" → thinking stays ON
```

Without `off: "none"` in the map, the `else` branch fires: no `reasoning_effort`
is sent, and Neuralwatt's default (`high`) keeps reasoning on despite the user
requesting off.

#### `clampThinkingLevel` and level availability (source: `models.js` L391-422)

```js
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function getSupportedThinkingLevels(model) {
    return EXTENDED_THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;       // null = hidden from picker
        if (level === "xhigh" || level === "max")
            return mapped !== undefined;          // only if explicitly in map
        return true;                              // off/minimal/low/medium/high always shown
    });
}
```

This is why `xhigh` and `max` are absent from the map: including them would
show them in the thinking-level picker, but they'd just alias to `high` (the
model has no distinct xhigh/max), which is misleading.

### `compat`

Derived from API capabilities as `buildModels` in pi-neuralwatt does:

- `developer_role: false` → `supportsDeveloperRole: false` (Qwen uses system role)
- `reasoning_effort: true` → `supportsReasoningEffort` left default (supported)
- `thinkingFormat: "openai"` (auto-detected — provider matches no special pattern)

### API key resolution (`resolve-config-value.js`)

The `apiKey` field is resolved by pi's
`@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js`, which
supports three forms:

| Form | Example | Behavior |
|---|---|---|
| `$VAR` / `${VAR}` | `"$NEURALWATT_API_KEY"` | Env var looked up at request time |
| `!command` | `"!kwallet-query ..."` | Shell command executed at request time; stdout = key; cached for process lifetime |
| literal | `"IGNORED"` | Sent verbatim as Bearer token |

This config uses `!command`. The command runs via `execSync` (`/bin/sh -c`),
stdout is captured and trimmed to become the Bearer token. The result is cached
for the process lifetime (queried once per session, not per request).

If the command exits non-zero, `execSync` throws, pi catches it, and returns
`undefined` — a clean "Failed to resolve API key" error. No garbage-key failure
mode: `kwallet-query` exits 4 on missing entry, 1 on missing wallet, 0 on
success. (Verified empirically.)

Note: little-coder's own `resolveApiKey` in `config.ts`
(`return env[configured] ?? configured`) is only used for the local `/props`
context-window probe, which never runs for non-llamacpp providers. The actual
API key resolution for requests goes through pi's `resolve-config-value.js`.

### Why not pi-neuralwatt?

The [`pi-neuralwatt`](https://pi.dev/packages/pi-neuralwatt) extension was
evaluated and rejected:

1. **Drops vision** — its `buildModels` hardcodes `input: ["text"]`, losing the
   image input capability that Qwen3.6-35B supports (`capabilities.vision:
   true`). This is unacceptable.
2. **Clobbers models.json registration** — it calls
   `pi.registerProvider("neuralwatt", ...)` at startup with a cached/empty
   model list, overwriting the models.json entry. On cold start (no cache
   file), this registers an empty list and the default model doesn't resolve.
3. **Not loaded by default** — little-coder doesn't auto-load pi extensions
   (`--with-pi-extensions` / `LITTLE_CODER_PI_EXTENSIONS=1` required, off by
   design for small models — see `bin/little-coder.mjs` L227).
4. **Energy pricing is additive** — the plugin's `cost` field is still
   token-based (mapped from `/v1/models` pricing). Energy data (joules/kWh) is
   surfaced separately via `/neuralwatt:energy` slash command and status-bar
   widget, not in the model registration. So installing the plugin for
   "energy pricing instead of token pricing" doesn't actually replace the token
   cost field.

## Permission gate

Source: `.pi/extensions/permission-gate/index.ts` +
`.pi/extensions/_shared/shell-write.ts`.

### Modes

| Mode | Env var | Behavior |
|---|---|---|
| `auto` (default) | `LITTLE_CODER_PERMISSION_MODE` not set or `=auto` | Whitelist: commands matching `BUILTIN_SAFE_PREFIXES` pass silently; everything else blocked |
| `manual` | `=manual` | Every shell command prompts the user before execution (no whitelist) |
| `accept-all` | `=accept-all` | No gate — all commands pass silently |

This machine is set to `manual` (fish: `set -Ux LITTLE_CODER_PERMISSION_MODE
manual`).

### Whitelist (`auto` mode)

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
tools. The gate analyzes all segments of `&&`/`||`/`;`/`|` chains independently
(issue #70), and strips heredoc bodies before analysis to avoid false
positives.

**`rm` is off the whitelist by design.** Use `LITTLE_CODER_BASH_ALLOW=rm` to
add it.

### Adding commands in `auto` mode

`LITTLE_CODER_BASH_ALLOW` (comma-separated, merges with builtins):

```fish
set -Ux LITTLE_CODER_BASH_ALLOW "rm,make,cargo,docker,go,nix"
```

### When a command is blocked

The agent receives a structured error naming the refused binary and
instructions. The gate covers all shell-executing tools (`bash`, `Bash`,
`ShellSession`, `ShellStart`) per issue #70 — do not route around a refusal
through `python3 -c`, `node -e`, `env bash -c`, or `find -exec`. If a file
needs changing, use `edit`/`write` (no shell needed). Otherwise tell the user
the command was refused and that they can allow it.

## Canceling the agent loop

### Known limitation

Esc only aborts the **current LLM streaming call** or **running bash command** —
not the agent loop as a whole. After abort, the agent loop
(`_handlePostAgentRun` → `agent.continue()`) may continue if:

- The model had already produced tool calls before Esc was pressed
- A blocked tool result (e.g. "No" in manual mode) goes back to the model,
  which starts a new streaming call to decide what to do next
- Queued steering/follow-up messages remain

### Keybindings (source: `keybindings.js`)

| Key | Action | What it does |
|---|---|---|
| **Esc** | `app.interrupt` | Aborts current LLM streaming call or bash execution |
| **Ctrl-C** | `app.clear` | Clears the editor text input — does NOT abort the agent |
| **Ctrl-D** | `app.exit` | Exits the app (only when editor is empty) |
| **Ctrl-Z** | `app.suspend` | Suspends process to background (`SIGTSTP`) |

**Ctrl-C does not abort the agent.** It clears the editor. This is a common
source of confusion.

### Esc branching logic (source: `interactive-mode.js` L2015-2021)

```js
this.defaultEditor.onEscape = () => {
    if (this.session.isStreaming) {
        this.restoreQueuedMessagesToEditor({ abort: true });  // abort LLM call
    }
    else if (this.session.isBashRunning) {
        this.session.abortBash();                            // kill bash
    }
    else if (this.isBashMode) {
        this.editor.setText("");                             // clear input
    }
};
```

During auto-retry backoff, Esc cancels the retry (via `session.abortRetry()`).
During compaction, Esc cancels compaction (via `session.abortCompaction()`).
These temporarily replace the default Escape handler.

### The `manual` permission interaction

In `manual` mode, selecting "No" on a permission prompt blocks the tool call
(`{ block: true }`), but the blocked result goes back to the model as a tool
error. The agent loop continues — the model gets the blocked result, makes
another LLM call, and starts streaming again. This can create a loop that's
hard to interrupt with Esc, because the window between the block and the next
streaming call is very short.

### Reliable workaround

```bash
/quit              # exits the TUI cleanly (preserves session)
little-coder -c    # resume the session (--continue)
```

### Known issues

| Issue | Title | Status |
|---|---|---|
| [pi #5177](https://github.com/earendil-works/pi/issues/5177) | Esc/Ctrl-C sometimes can't stop the model; model continues thinking and running tools after abort | Closed (bug) |
| [little-coder #114](https://github.com/itayinbarr/little-coder/issues/114) | Esc unable to stop agent during compaction/loop; `/quit` + resume fixes it | Closed |
| [pi #2716](https://github.com/earendil-works/pi/issues/2716) | Escape triggering abort during bash crashes with unhandled `AbortError` | Reported |
| [pi #4118](https://github.com/earendil-works/pi/issues/4118) | Request for `stopAfterTurn()` — graceful stop after current turn, not mid-stream | **Closed as not planned** |
| [pi #3344](https://github.com/earendil-works/pi/issues/3344) | Aborted tool calls can corrupt conversation state (orphaned `tool_use` blocks) | Reported |

The core architecture: tool results are data the loop must process, not a
signal to stop. A blocked tool call is treated as a normal result — the loop
doesn't know the user wanted to stop, only that a tool returned an error. A
`stopAfterTurn()` API was requested (#4118) and rejected.

## Auto-retry

On transient errors (overloaded, rate limit, 5xx, connection drops), pi
auto-retries with exponential backoff (default: 3 attempts). During retry
delay, a `RetryStatusIndicator` shows "(Esc to cancel)". Esc during retry
cancels the retry.

Retry is **not** triggered by context overflow (handled by compaction instead)
or non-retryable errors (400, 401, etc.).

## Headless mode

`little-coder -p` (print/headless mode) does **not** inject the configured
default model — `decideDefaultModel` returns `null` when `headless` is true
(source: `bin/default-model.mjs`). Always pass `--model` explicitly:

```bash
little-coder --no-tools --model neuralwatt/qwen3.6-35b -p "your prompt"
```

Bare interactive `little-coder` (no flags) does inject the default on first run.

## pi extensions not loaded by default

little-coder does NOT auto-load pi ecosystem extensions (`--no-extensions` is
the default). To load them:

- Pass `--with-pi-extensions` on the CLI, or
- Set `LITTLE_CODER_PI_EXTENSIONS=1`, or
- Drop extension `.ts` files in `~/.config/little-coder/extensions/`
  (always loaded, survives `npm install -g little-coder@latest`)

## Adapting to a different secret store

The `apiKey` `!command` form runs any shell command. Replace the
`kwallet-query` invocation:

| Secret store | `apiKey` value |
|---|---|
| Env var | `"$NEURALWATT_API_KEY"` |
| pass (password-store) | `"!pass neuralwatt/api-key"` |
| 1Password CLI | `"!op read 'neuralwatt-api-key'"` |
| Bitwarden CLI | `"!bw get password neuralwatt-api-key"` |
| HashiCorp Vault | `"!vault kv get -field=api_key secret/neuralwatt"` |
| Literal key (insecure) | `"sk-..."` |

For KWallet with a different wallet/folder/entry:
`kwallet-query -f <folder> -r <entry> <wallet>`

## Adapting to a different machine

1. Install little-coder: `npm install -g little-coder`
2. Store the API key in your secret manager (see above)
3. Copy `models.json` to the config path:
   `mkdir -p ~/.config/little-coder && cp models.json ~/.config/little-coder/models.json`
4. If not using KWallet, replace the `apiKey` value
5. Set `LITTLE_CODER_PERMISSION_MODE` (see Permission gate)
6. Verify: `little-coder --list-models`

## Cleanup

A dummy KWallet entry `lc-kwallet-fmttest` (value `dummy-api-key-12345`) was
created during testing in the `Passwords` folder of `kdewallet`.
`kwallet-query` cannot delete entries — remove it via KWalletManager GUI.

## Per-model profiles (`.pi/settings.json`)

Separate from this config. Controls per-model tuning (`thinking_budget`,
`context_limit`, `temperature`, `benchmark_overrides`) referenced by the
`<provider>/<id>` key. Profiles don't register or describe models — they only
tune how little-coder runs against models that are already registered.
