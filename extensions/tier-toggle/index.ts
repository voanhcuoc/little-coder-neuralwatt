import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VALID_TIERS = ["standard", "flex"] as const;
type Tier = (typeof VALID_TIERS)[number];

function getTier(): Tier {
  const v = process.env.LITTLE_CODER_SERVICE_TIER;
  if (v === "standard" || v === "flex") return v;
  return "standard";
}

/** Permission mode from the permission-toggle extension. */
function getPermissionMode(): string | undefined {
  const v = process.env.LITTLE_CODER_PERMISSION_MODE;
  return v;
}

/** Combined status string, e.g. `"flex · auto"` or `"auto"` etc. */
function buildFullStatus(): string {
  const tier = getTier();
  const perm = getPermissionMode();
  const parts: string[] = [];
  if (tier === "flex") parts.push("flex");
  if (perm && perm !== "auto") parts.push(perm);
  if (parts.length > 0) return parts.join(" · ");
  return "";
}

export default function (pi: ExtensionAPI) {
  /** Set footer status on session start so initial values show immediately. */
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("nw-status", buildFullStatus());
  });

  /** Inject service_tier into the request body — Neuralwatt only. */
  pi.on("before_provider_request", async (event, ctx) => {
    const p = (event as any).payload;
    if (p && typeof p === "object") {
      if ((p as any).provider !== "neuralwatt") return;
      if (getTier() === "flex" && !(p as any).service_tier) {
        (p as any).service_tier = "flex";
      }
    }
    ctx.ui.setStatus("nw-status", buildFullStatus());
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
      ctx.ui.setStatus("nw-status", buildFullStatus());
    },
  });
}
