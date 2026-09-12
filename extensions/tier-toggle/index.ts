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

/** Render a dim annotation: `(held X.Xs)` for custom entries */
function holdRenderer(
  entry: { customType: string; data: unknown },
  _opts: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const data = entry.data as { holdSec: number } | undefined;
  if (!data || data.holdSec === undefined || data.holdSec < 0.2) return undefined;
  const box = new Box(2, 1);
  box.addChild(new Text(theme.fg("dim", `(held ${formatHold(data.holdSec)})`), 1, 0));
  return box;
}

export default function (pi: ExtensionAPI) {
  const CUSTOM_TYPE = "nw-flex-hold";
  pi.registerEntryRenderer(CUSTOM_TYPE, holdRenderer);

  /**
   * Measure total hold time = wall-clock from request send to response complete.
   *
   * The flex server holds the HTTP connection open with keepalive frames from
   * the moment we send the request until the last token arrives. ALL of that
   * elapsed time IS hold time — the user cannot see tokens, cannot interact,
   * the connection is held the entire time.
   *
   * Measured with Date.now() from before_provider_request to after_provider_response.
   */
  let requestWallTime: number | null = null;

  pi.on("before_provider_request", async (event) => {
    (event as any).payload = injectServiceTier(
      (event as any).payload,
      getTier(),
    );
    if (getTier() === "flex") {
      requestWallTime = Date.now();
    }
  });

  pi.on("after_provider_response", async () => {
    if (requestWallTime === null) return;
    const holdMs = Date.now() - requestWallTime;
    requestWallTime = null;

    if (holdMs < 200) return; // noise threshold (200ms)
    pi.appendEntry(CUSTOM_TYPE, { holdSec: holdMs / 1000 });
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
