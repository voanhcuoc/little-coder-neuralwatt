import type { ExtensionAPI, BeforeProviderRequestEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";

// Adds /tier slash command to switch between "standard" and "flex" service tier
// at runtime without restarting. Works because the before_provider_request handler
// reads the persisted tier at request time, so switching takes effect immediately.
//
// The service_tier field is injected into the request body (payload) so that:
// - Prompt caching is preserved (model name stays unchanged, not suffixed with "-flex")
// - The same server-side prompt cache is shared between standard and flex tiers
//
// Usage:
//   /tier              — show current tier
//   /tier standard      — use standard tier (default)
//   /tier flex          — use flex tier (discounted, may delay first token)
//
// Tier is persisted to ~/.config/little-coder/service-tier across sessions.

const TIER_FILE = `${process.env.XDG_CONFIG_HOME ?? "/root"}/.config/little-coder/service-tier`;
const VALID_TIERS = ["standard", "flex"] as const;
type Tier = (typeof VALID_TIERS)[number];

function readTier(): Tier {
  // Env var takes precedence (for quick mid-session switching via setEnv)
  const envV = process.env.LITTLE_CODER_SERVICE_TIER;
  if (envV === "standard" || envV === "flex") return envV;
  // Fall back to file
  try {
    const raw = fs.readFileSync(TIER_FILE, "utf-8").trim();
    if (raw === "standard" || raw === "flex") return raw;
  } catch {
    // File doesn't exist — default to standard
  }
  return "standard";
}

function writeTier(tier: Tier): void {
  const dir = TIER_FILE.replace(/\/[^/]+$/, "");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // dir already exists
  }
  fs.writeFileSync(TIER_FILE, tier, "utf-8");
}

function injectServiceTier(payload: unknown, tier: Tier): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  // Only add service_tier if not already present (flex; standard is default)
  if (p.service_tier === undefined && tier === "flex") {
    p.service_tier = "flex";
  }
  return payload;
}

export default function (pi: ExtensionAPI) {
  // Register the /tier slash command
  pi.registerCommand("tier", {
    description: "Switch service tier: standard (default) or flex (discounted, may delay first token)",
    argumentHint: "standard|flex",
    handler: async (args: string, ctx) => {
      const requested = args.trim().toLowerCase();

      if (!requested) {
        const current = readTier();
        ctx.ui.notify(`Service tier: ${current}`, "info");
        if (current === "flex") {
          ctx.ui.notify(
            "Flex tier: requests may experience delay before first token. Use /tier standard to switch back.",
            "info",
          );
        }
        return;
      }

      if (!VALID_TIERS.includes(requested as Tier)) {
        ctx.ui.notify(
          `Invalid tier "${requested}". Use: standard or flex.`,
          "error",
        );
        return;
      }

      const tier = requested as Tier;
      process.env.LITTLE_CODER_SERVICE_TIER = tier;
      writeTier(tier);

      ctx.ui.notify(`Service tier: ${tier}`, "success");
      if (tier === "flex") {
        ctx.ui.notify(
          "Remember: streaming is required for flex tier. Non-streaming requests fall back to standard tier.",
          "info",
        );
      }
    },
  });

  // Hook into every provider request to inject service_tier into the payload
  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent) => {
    const payload = (event as any).payload;
    const tier = readTier();
    return injectServiceTier(payload, tier);
  });
}
