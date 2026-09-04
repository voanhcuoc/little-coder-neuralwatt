# little-coder Neuralwatt Provider

Configures [little-coder](https://www.npmjs.com/package/little-coder) to use
**Qwen3.6-35B-A3B** hosted on [Neuralwatt](https://portal.neuralwatt.com) as
the default model, with the API key stored in KDE KWallet.

## Quick start

```bash
# 1. Install little-coder
npm install -g little-coder

# 2. Store your Neuralwatt API key in KWallet
printf '%s' 'sk-YOUR-KEY' | kwallet-query -f Passwords -w neuralwatt-api-key kdewallet

# 3. Copy the config and extension
mkdir -p ~/.config/little-coder
cp models.json ~/.config/little-coder/models.json
mkdir -p ~/.config/little-coder/extensions/permission-toggle
cp extensions/permission-toggle/index.ts ~/.config/little-coder/extensions/permission-toggle/index.ts
mkdir -p ~/.config/little-coder/extensions/image-pruner
cp extensions/image-pruner/index.ts ~/.config/little-coder/extensions/image-pruner/index.ts

# 4. Set permission mode to manual (optional but recommended)
#    For fish:
fish -c 'set -Ux LITTLE_CODER_PERMISSION_MODE manual'

# 5. Verify
little-coder --list-models
little-coder --no-tools --model neuralwatt/qwen3.6-35b -p "What is 2+2? Reply with only the number."
```

## Files

```
models.json                          →  copy to ~/.config/little-coder/models.json
extensions/permission-toggle/index.ts →  copy to ~/.config/little-coder/extensions/permission-toggle/index.ts
extensions/image-pruner/index.ts     →  copy to ~/.config/little-coder/extensions/image-pruner/index.ts
README.md                            →  this file
AGENTS.md                            →  full technical reference for AI agents setting up this config
```

## What this gives you

- **Neuralwatt/qwen3.6-35b** as the default model (replaces local llama.cpp 35B)
- API key fetched from KWallet at call time (never stored in plaintext)
- Vision preserved (`text + image` input)
- Reasoning effort correctly mapped (off → none; everything else → high)
- Permission mode set to `manual` (every shell command prompts before running)
- `/permission` slash command to switch modes at runtime (manual ↔ auto ↔ accept-all)
- Image pruning: automatically strips excess images (beyond 4) from context before each API request

## Notes

- Get a Neuralwatt API key at
  [portal.neuralwatt.com](https://portal.neuralwatt.com) → Dashboard → API Keys
- Requires KDE KWallet (`kwalletd6` + `kwallet-query`), normally available on
  KDE Plasma desktop sessions
- If not using KWallet, see "Adapting" section in [AGENTS.md](AGENTS.md)
- Esc doesn't always stop the agent loop — see AGENTS.md for details and the
  `/quit` + resume workaround
