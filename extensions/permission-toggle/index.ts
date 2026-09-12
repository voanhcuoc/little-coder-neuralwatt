import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shared status key with tier-toggle. */
const STATUS_KEY = "nw-status";

/** Build a status string like `flex · accept-all` from shared env vars. */
function buildStatus(): string {
  const tier = process.env.LITTLE_CODER_SERVICE_TIER;
  const perm = process.env.LITTLE_CODER_PERMISSION_MODE;
  const parts: string[] = [];
  if (tier === "flex") parts.push("flex");
  if (perm && perm !== "auto") parts.push(perm);
  return parts.join(" · ");
}

// Adds /permission slash command to switch between permission modes at runtime
// without restarting. Works because permission-gate reads
// process.env.LITTLE_CODER_PERMISSION_MODE per-tool-call (not cached at startup),
// so updating the env var takes effect immediately on the next tool invocation.
//
// Modes:
//   manual     — every shell command prompts before execution
//   auto       — whitelist: safe commands pass, rest blocked (shipped default)
//   accept-all — no gate, all commands pass silently
//
// Usage:
//   /permission              — show current mode
//   /permission manual       — switch to manual
//   /permission auto         — switch to auto
//   /permission accept-all   — switch to accept-all

const VALID_MODES = ["manual", "auto", "accept-all"] as const;
type Mode = (typeof VALID_MODES)[number];

function currentMode(): Mode {
  const v = process.env.LITTLE_CODER_PERMISSION_MODE;
  if (v === "manual" || v === "accept-all") return v;
  return "auto";
}

export default function (pi: ExtensionAPI) {
  /** Refresh combined status on session start so initial values show. */
  pi.on("session_start", async (_event, ctx) => {
    const s = buildStatus();
    if (s) ctx.ui.setStatus(STATUS_KEY, s);
  });

  pi.registerCommand("permission", {
    description: "Switch permission mode: manual (prompt), auto (whitelist), accept-all (no gate)",
    argumentHint: "manual|auto|accept-all",
    handler: async (args: string, ctx) => {
      const requested = args.trim().toLowerCase();

      if (!requested) {
        ctx.ui.notify(`Permission mode: ${currentMode()}`, "info");
        return;
      }

      if (!VALID_MODES.includes(requested as Mode)) {
        ctx.ui.notify(
          `Invalid mode "${requested}". Use: manual, auto, or accept-all.`,
          "error",
        );
        return;
      }

      const mode = requested as Mode;
      if (mode === "auto") {
        delete process.env.LITTLE_CODER_PERMISSION_MODE;
      } else {
        process.env.LITTLE_CODER_PERMISSION_MODE = mode;
      }

      ctx.ui.notify(`Permission mode: ${mode}`, "info");
      const status = buildStatus();
      if (status) ctx.ui.setStatus(STATUS_KEY, status);
    },
  });
}
