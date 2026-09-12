import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VALID_TIERS = ["standard", "flex"] as const;
type Tier = (typeof VALID_TIERS)[number];

function getTier(): Tier {
  const v = process.env.LITTLE_CODER_SERVICE_TIER;
  if (v === "standard" || v === "flex") return v;
  return "standard";
}

export default function (pi: ExtensionAPI) {
  console.warn("[tier-toggle] loaded");

  /** Inject service_tier into the request body — Neuralwatt only. */
  pi.on("before_provider_request", async (event, ctx) => {
    const p = (event as any).payload;
    if (p && typeof p === "object") {
      if ((p as any).provider !== "neuralwatt") {
        console.warn("[tier-toggle] skipping non-neuralwatt:", (p as any).provider);
        return;
      }
      if (getTier() === "flex" && !(p as any).service_tier) {
        (p as any).service_tier = "flex";
      }
    }
    // Update footer status bar — flex shows "flex", standard is hidden
    const tier = getTier();
    console.warn("[tier-toggle] setting status:", tier);
    if (tier === "flex") {
      ctx.ui.setStatus("nw-tier", "flex");
    } else {
      ctx.ui.setStatus("nw-tier", undefined);
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
      process.env.LITTLE_CODER_SERVICE_TIER = requested as Tier;
      ctx.ui.notify(`Service tier: ${requested}`, "info");

      if (requested === "flex") {
        ctx.ui.setStatus("nw-tier", "flex");
      } else {
        ctx.ui.setStatus("nw-tier", undefined);
      }
    },
  });
}
