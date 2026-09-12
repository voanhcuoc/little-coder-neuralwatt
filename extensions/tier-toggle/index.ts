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

  let requestStartNs: bigint | null = null;

  /**
   * Measure hold (queue) time from request send to first token arrival.
   *
   * We measure delta to MESSAGE_START (not after_provider_response).
   * after_provider_response fires when the ENTIRE streaming response
   * completes — so that measurement includes the full generation time
   * on top of the queue hold, making numbers look inflated.
   *
   * message_start fires on the first token/content chunk = actual
   * time user waited before seeing anything (TTFT = hold time).
   */
  pi.on("before_provider_request", async (event) => {
    (event as any).payload = injectServiceTier(
      (event as any).payload,
      getTier(),
    );
    requestStartNs = getTier() === "flex"
      ? BigInt(process.hrtime.bigint())
      : null;
  });

  pi.on("message_start", ({ message }) => {
    if (message.role !== "assistant" || !requestStartNs) return;
    // Clear immediately so subsequent message_start events
    // (e.g. after tool calls) don't emit annotations.
    const startNs = requestStartNs;
    requestStartNs = null;
    const nowNs = BigInt(process.hrtime.bigint());
    const holdS = Number(nowNs - startNs) / 1e9;
    if (holdS < 0.2) return; // noise threshold
    pi.appendEntry(CUSTOM_TYPE, { holdSec: holdS });
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
