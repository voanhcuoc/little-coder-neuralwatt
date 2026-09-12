import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";

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
  if (p.service_tier === undefined && tier === "flex") {
    p.service_tier = "flex";
  }
  return payload;
}

/** Convert seconds to a short hold duration. e.g. 0.5 -> "500ms", 3.137 -> "3.1s" */
function formatHold(sec: number): string {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 30) return `${sec.toFixed(1)}s`.replace(/\.0$/, "s");
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** Render a dim annotation: `(queued X.Xs)` for custom entries */
function holdRenderer(
  entry: { customType: string; data: unknown },
  _opts: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const data = entry.data as { queueSec: number } | undefined;
  if (!data || data.queueSec === undefined || data.queueSec < 0.3) return undefined;
  const box = new Box(2, 1);
  box.addChild(new Text(theme.fg("dim", `(queued ${formatHold(data.queueSec)})`), 1, 0));
  return box;
}

export default function (pi: ExtensionAPI) {
  const CUSTOM_TYPE = "nw-flex-hold";
  pi.registerEntryRenderer(CUSTOM_TYPE, holdRenderer);

  /**
   * Measure flex queue hold: time from request send to response headers received.
   *
   * for flex tier, the server holds the TCP connection open while the request
   * is waiting in queue behind standard tier. this is the actual queue hold.
   *
   * after headers arrive, inference begins. ttft = queue + prompt processing.
   * if queue time >> normal ttft, the token was queued (flex tier).
   * if queue time ≈ normal ttft, it just arrived quickly (or no queue).
   */
  let queueStartNs: bigint | null = null;

  pi.on("before_provider_request", async (event) => {
    (event as any).payload = injectServiceTier(
      (event as any).payload,
      getTier(),
    );
    if (getTier() === "flex") {
      queueStartNs = BigInt(process.hrtime.bigint());
    }
  });

  pi.on("after_provider_response", () => {
    if (queueStartNs === null) return;
    const queueSec = (Date.now() - Number(queueStartNs) / 1e6) / 1000;
    queueStartNs = null;

    if (queueSec < 0.3) return; // normal / no queue
    pi.appendEntry(CUSTOM_TYPE, { queueSec });
  });

  pi.registerCommand("tier", {
    description: "Switch service tier: standard (default) or flex (discounted, may delay first token)",
    argumentHint: "standard|flex",
    handler: async (args: string, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!requested) { ctx.ui.notify(`Service tier: ${getTier()}`, "info"); return; }
      if (!VALID_TIERS.includes(requested as Tier)) { ctx.ui.notify(`Invalid tier "${requested}". Use: standard or flex.`, "error"); return; }
      setTier(requested as Tier);
      ctx.ui.notify(`Service tier: ${requested}`, "info");
    },
  });
}
