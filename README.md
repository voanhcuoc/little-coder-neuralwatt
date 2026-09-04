# little-coder Neuralwatt Provider Config

User override for [little-coder](https://www.npmjs.com/package/little-coder) that
adds Neuralwatt as a provider for **Qwen3.6-35B-A3B** and sets it as the default
model — replacing the shipped `llamacpp/qwen3.6-35b-a3b` local model that this
machine can't run.

## File layout

```
models.json   # copy to ~/.config/little-coder/models.json
README.md     # this file
```

## What it does

- Adds `neuralwatt` provider pointing at `https://api.neuralwatt.com/v1`
- Sets `default` to `neuralwatt/qwen3.6-35b`
- API key fetched from **KDE KWallet** at call time (never stored in the file)
- Preserves vision (`input: ["text", "image"]`) — the `pi-neuralwatt` extension
  was evaluated and rejected because it drops vision to `["text"]` only
- `thinkingLevelMap` maps pi's thinking levels to Neuralwatt's two-level effort
  model (high/none), including the critical `off → "none"` mapping that allows
  disabling reasoning (without it, the API defaults to `high` silently)
- `compat: { supportsDeveloperRole: false }` — Neuralwatt reports
  `developer_role: false`; using system role instead

## Prerequisites

### 1. little-coder installed

```bash
npm install -g little-coder
```

### 2. Neuralwatt API key

Get one at [portal.neuralwatt.com](https://portal.neuralwatt.com) → Dashboard →
API Keys.

### 3. KDE KWallet (KDE Wallet / `kwalletd6`)

The `apiKey` field uses pi's `!command` resolver (see
[resolution chain](#api-key-resolution-chain) below). The key is fetched at
call time from KWallet — never stored in `models.json`.

Store the key:

```bash
printf '%s' 'sk-YOUR-NEURALWATT-KEY' | kwallet-query -f Passwords -w neuralwatt-api-key kdewallet
```

Requirements:
- `kwallet-query` installed (KDE Wallet CLI tool)
- `kwalletd6` running (automatic on KDE Plasma 6 desktop sessions)
- `DBUS_SESSION_BUS_ADDRESS` set in the launch environment (normal desktop
  login provides this; headless/systemd sessions may not)

If KWallet isn't available, see
[Adapting to a different secret store](#adapting-to-a-different-secret-store)
below.

## Install

```bash
# Copy the override to little-coder's user-config path:
mkdir -p ~/.config/little-coder
cp models.json ~/.config/little-coder/models.json
```

little-coder's override resolution (first match wins):
1. `$LITTLE_CODER_MODELS_FILE` — explicit path
2. `$XDG_CONFIG_HOME/little-coder/models.json`
3. `~/.config/little-coder/models.json`

Merge semantics: the `neuralwatt` provider key fully replaces any same-keyed
entry in the shipped `models.json`. Providers only in the shipped file
(llamacpp, ollama, lmstudio) are kept — this override only adds `neuralwatt`
and overrides `default`.

## Verify

```bash
# Should list neuralwatt/qwen3.6-35b with 131.1K context, thinking yes, images yes
little-coder --list-models

# Smoke test (explicit --model; headless -p mode skips default injection by design)
little-coder --no-tools --model neuralwatt/qwen3.6-35b -p "What is 2+2? Reply with only the number."

# Bare interactive launch should print the neuralwatt default banner
little-coder
```

## Configuration details

All values below are sourced from Neuralwatt's live API
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
(which leaves it `undefined` for this model). The API supports only two
effective effort levels: `high` and `none`, with effort aliases mapping
everything else to `high`.

| pi level | sends to API | rationale |
|---|---|---|
| `off` | `reasoning_effort: "none"` | **Critical:** without this mapping, `off` → pi sends no `reasoning_effort` → API defaults to `high` → thinking stays ON silently |
| `minimal` | `reasoning_effort: "high"` | API aliases minimal→high; explicit is semantically correct |
| `low` | `reasoning_effort: "high"` | Same alias |
| `medium` | `reasoning_effort: "high"` | Same alias |
| `high` | `reasoning_effort: "high"` | Passthrough |
| `xhigh` | absent | `getSupportedThinkingLevels` hides levels not in the map (line 399: `return mapped !== undefined`); model has no distinct xhigh |
| `max` | absent | Same — no distinct max level |

### `compat`

Derived from API capabilities as `buildModels` in pi-neuralwatt does:
- `developer_role: false` → `supportsDeveloperRole: false`
- `reasoning_effort: true` → `supportsReasoningEffort` left default (supported)
- Auto-detected `thinkingFormat: "openai"` (provider `neuralwatt` matches no
  special detection pattern in `detectCompat`), so the standard
  `reasoning_effort` request path is used.

### API key resolution chain

The `apiKey` field is resolved by pi's `resolve-config-value.js`
(`@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js`), which
supports three forms:

| Form | Example | Behavior |
|---|---|---|
| `$VAR` / `${VAR}` | `"$NEURALWATT_API_KEY"` | Env var looked up at request time |
| `!command` | `"!kwallet-query ..."` | Shell command executed at request time; stdout = key; cached for process lifetime |
| literal | `"IGNORED"` | Sent verbatim as Bearer token |

This config uses `!command`. The command's stdout is captured (trimmed) and
used as the Bearer token. If the command exits non-zero, pi throws
"Failed to resolve API key" — a clean failure, not a garbage-key attempt.

### Why not install pi-neuralwatt?

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
   design for small models).
4. **Energy pricing is additive, not replacing token cost** — the plugin's
   `cost` field is still token-based (mapped from `/v1/models` pricing). Energy
   data is surfaced separately via `/neuralwatt:energy` slash command and
   status-bar widget, not in the model registration.

## Adapting to a different secret store

The `apiKey` `!command` form runs any shell command. Replace the
`kwallet-query` invocation with your secret manager's CLI:

| Secret store | `apiKey` value |
|---|---|
| Env var | `"$NEURALWATT_API_KEY"` |
| pass (password-store) | `"!pass neuralwatt/api-key"` |
| 1Password CLI | `"!op read 'neuralwatt-api-key'"` |
| Bitwarden CLI | `"!bw get password neuralwatt-api-key"` |
| HashiCorp Vault | `"!vault kv get -field=api_key secret/neuralwatt"` |
| Literal key (insecure) | `"sk-..."` |

## Adapting to a different machine

1. Install little-coder: `npm install -g little-coder`
2. Store the API key in your secret manager (see above)
3. Copy `models.json` to the config path (see [Install](#install))
4. If not using KWallet, replace the `apiKey` value
5. If using a different wallet name/folder/entry, update the `kwallet-query`
   arguments: `kwallet-query -f <folder> -r <entry> <wallet>`
6. Verify with `little-coder --list-models`

## Permission mode

The default permission mode is `auto` — a shell command whitelist that blocks
anything not in `BUILTIN_SAFE_PREFIXES`. To change it, set
`LITTLE_CODER_PERMISSION_MODE`:

| Mode | Behavior |
|---|---|
| `auto` (default) | Whitelist: safe commands pass, everything else blocked |
| `manual` | Every shell command prompts before execution (no whitelist) |
| `accept-all` | No gate — all commands pass silently |

To persist in fish:
```fish
set -Ux LITTLE_CODER_PERMISSION_MODE manual
```

To add specific commands to the `auto` whitelist without switching modes:
```fish
set -Ux LITTLE_CODER_BASH_ALLOW "rm,make,cargo,docker"
```

## Notes

- This override only declares the `neuralwatt` provider; shipped providers
  (llamacpp, ollama, lmstudio) are preserved by the merge semantics.
- The `default` key is first-run-only: once you switch models in an interactive
  session, pi persists the selection and the default stops applying.
- `.pi/settings.json` (per-model profiles like `thinking_budget`,
  `context_limit`, `temperature`) is a separate concern and not modified here.
