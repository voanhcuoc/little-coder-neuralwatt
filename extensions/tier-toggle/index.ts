import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Adds /tier slash command to switch between "standard" and "flex" service tier
// at runtime without restarting. Tier is per-session (process-level): each
// little-coder process tracks its own tier independently, so two concurrent
// sessions can use different tiers.
//
// The service_tier field is injected into the request body (payload) so that:
// - Prompt caching is preserved (model name stays unchanged, not suffixed with
//   "-flex"; the same server-side prompt cache is shared across tiers)
// - No per-process disk state is needed – the env var is the only state
//
// Usage:
//   /tier              — show current tier
//   /tier standard      — use standard tier (default)
//   /tier flex          — use flex tier (35% discount, may delay first token)

const VALID_TIERS = ["standard", "flex"] as const;
type Tier = (typeof VALID_TIERS)[number];

function getTier(): Tier {
  const v = process.env.LITTLE_CODER_SERVICE_TIER;
  if (v === "standard" || v === "flex") return v;
  return "standard";
}

function setTier(tier: Tier): void {
  process.env.LITTLE_CODER_SERVICE_TIER = tier;
}

function injectServiceTier(payload: unknown, tier: Tier): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  // Only inject when flex; standard is the default (no field needed)
  if (p.service_tier === undefined && tier === "flex") {
    p.service_tier = "flex";
  }
  return payload;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("tier", {
    description: "Switch service tier: standard (default) or flex (discounted, may delay first token)",
    argumentHint: "standard|flex",
    handler: async (args: string, ctx) => {
      const requested = args.trim().toLowerCase();

      if (!requested) {
        ctx.ui.notify(`Service tier: ${getTier()}`, "info");
        return;
      }

      if (!VALID_TIERS.includes(requested as Tier)) {
        ctx.ui.notify(
          `Invalid tier "${requested}". Use: standard or flex.`,
          "error",
        );
        return;
      }

      setTier(requested as Tier);
      ctx.ui.notify(`Service tier: ${requested}`, "info");
    },
  });

  // Inject service_tier into every provider request
  pi.on("before_provider_request", async (event) => {
    const payload = (event as any).payload;
    return injectServiceTier(payload, getTier());
  });
}
