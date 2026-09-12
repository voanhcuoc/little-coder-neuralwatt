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

/** Build a single-line status string (e.g. `(flex)`). */
function buildStatusLine(): string {
  const tier = getTier();
  if (tier === "flex") return "flex";
  return "";
}

export default function (pi: ExtensionAPI) {
  /** Inject service_tier into the request body — Neuralwatt only. */
  pi.on("before_provider_request", async (event) => {
    const p = (event as any).payload;
    if (p && typeof p === "object" && !p.provider) return;
    if ((p as any).provider !== "neuralwatt") return;
    if (getTier() === "flex" && !p.service_tier) {
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

  /** Show tier/permission status as a one-line widget above the editor. */
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.model;
    if (!model || model.provider !== "neuralwatt") return;
    const line = buildStatusLine();
    if (line) ctx.ui.setWidget("neuralwatt-tier", [line]);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setWidget("neuralwatt-tier", undefined);
  });

  /** Update the widget every request in case tier changed. */
  pi.on("before_provider_request", async (event, ctx) => {
    const p = (event as any).payload;
    if (p && (p as any).provider === "neuralwatt") {
      const line = buildStatusLine();
      if (line) ctx.ui.setWidget("neuralwatt-tier", [line]);
    }
  });
}
