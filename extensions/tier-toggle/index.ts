import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
  /**
   * Inject service_tier: "flex" into the request body so Neuralwatt
   * schedules the request in the flex pool.
   */
  pi.on("before_provider_request", async (event) => {
    const p = (event as any).payload;
    if (p && typeof p === "object" && getTier() === "flex" && !p.service_tier) {
      p.service_tier = "flex";
    }
  });

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
        ctx.ui.notify(`Invalid tier "${requested}". Use: standard or flex.`, "error");
        return;
      }
      setTier(requested as Tier);
      ctx.ui.notify(`Service tier: ${requested}`, "info");
    },
  });
}
