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

/** Render a dim annotation: `(q: 1.2s i: 3.4s)` for custom entries */
function holdRenderer(
  entry: { customType: string; data: unknown },
  _opts: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const data = entry.data as { queueSec: number; inferenceSec: number } | undefined;
  if (!data || data.queueSec === undefined || data.inferenceSec === undefined) return undefined;
  const total = data.queueSec + data.inferenceSec;
  if (total < 0.3) return undefined;

  const qStr = formatHold(data.queueSec);
  const iStr = formatHold(data.inferenceSec);
  const label = data.queueSec > data.inferenceSec * 2
    ? `q:${qStr} i:${iStr}`
    : data.inferenceSec > data.queueSec * 2
      ? `q:${qStr} i:${iStr}`
      : `q:${qStr} i:${iStr}`;

  const box = new Box(2, 1);
  box.addChild(new Text(theme.fg("dim", `( ${label} )`), 1, 0));
  return box;
}

export default function (pi: ExtensionAPI) {
  const CUSTOM_TYPE = "nw-flex-hold";
  pi.registerEntryRenderer(CUSTOM_TYPE, holdRenderer);

  /**
   * Decompose delay into queue time vs inference time.
   *
   * Timeline:
   *   before_provider_request ─────┐
   *                                 ├─ queue time (server held connection open)
   *   after_provider_response ─────┘
   *                                 ├─ inference time (prompt process + gen)
   *   message_end                   ┘
   *
   * Queue time high + inference normal = queued in flex tier.
   * Queue normal + inference high = slow server / long prompt.
   */
  let queueStartNs: bigint | null = null;
  let afterResponseNs: number | null = null;
  let generationStartMs: number | null = null;
  let generationEndMs: number | null = null;

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
    afterResponseNs = Date.now();
  });

  pi.on("message_start", ({ message }) => {
    if (message.role !== "assistant") return;
    if (generationStartMs !== null) return; // already recorded one
    generationStartMs = Date.now();
  });

  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant") return;
    if (queueStartNs === null) return; // not a flex request
    if (afterResponseNs === null || generationStartMs === null) return;

    generationEndMs = Date.now();
    const queueSec = (afterResponseNs - Number(queueStartNs) / 1e6) / 1000;
    const inferenceSec = (generationEndMs - generationStartMs) / 1000;

    queueStartNs = null;
    afterResponseNs = null;
    generationStartMs = null;
    generationEndMs = null;

    if (queueSec + inferenceSec < 0.3) return; // noise
    pi.appendEntry(CUSTOM_TYPE, { queueSec, inferenceSec });
  });

  pi.registerCommand("queue-status", {
    description: "Show queue vs inference timing for this turn",
    handler: async (_args: string, ctx) => {
      const entries = pi.getFooterEntries();
      const flexEntries = entries.filter(e => e.customType === "nw-flex-hold");
      if (flexEntries.length === 0) {
        ctx.ui.notify("No flex timing data for this turn", "info");
        return;
      }
      const entry = flexEntries[flexEntries.length - 1];
      const data = entry.data as { queueSec: number; inferenceSec: number } | undefined;
      if (!data) {
        ctx.ui.notify("No timing data available", "info");
        return;
      }
      
      const queue = formatHold(data.queueSec);
      const inference = formatHold(data.inferenceSec);
      const total = formatHold(data.queueSec + data.inferenceSec);
      
      let status = data.queueSec > data.inferenceSec * 2 
        ? "queued (flex tier)" 
        : data.inferenceSec > data.queueSec * 2 
          ? "slow inference (server crowded)" 
          : "mixed";
      
      ctx.ui.notify(`Queue: ${queue} | Inference: ${inference} | Total: ${total} | ${status}`, "info");
    },
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
