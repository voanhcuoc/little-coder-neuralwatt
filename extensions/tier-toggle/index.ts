import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";

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

/**  
 * Convert seconds to a short, rounded hold duration.
 * e.g. 0.5 → "500ms", 3.137 → "3.1s", 65 → "1m 5s"
 */
function formatHold(sec: number): string {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 30) return `${sec.toFixed(1)}s`.replace(/\.0$/, "s");
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

export default function (pi: ExtensionAPI) {
  let requestStartNs: bigint | null = null;
  let lastHoldSec: number | null = null;

  pi.registerCommand("tier", {
    description:
      "Switch service tier: standard (default) or flex (discounted, may delay first token)",
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

  /**
   * Record request start time when flex tier is active.
   *
   * Measurement: wall-clock delta between before_provider_request and
   * after_provider_response. On message_start for assistant responses,
   * we prepend a TextContent block to the streaming message content so
   * the hold annotation renders at the START of the model's response
   * in the scrollable transcript area.
   *
   * Note: the annotation IS included in the assistant message content
   * that gets persisted to the session file, so it will appear in future
   * context. It's a short `(held X.Xs)` line — negligible context impact.
   */
  pi.on("before_provider_request", async (event) => {
    (event as any).payload = injectServiceTier(
      (event as any).payload,
      getTier(),
    );
    const tier = getTier();
    if (tier === "flex") {
      requestStartNs = BigInt(process.hrtime.bigint());
    } else {
      requestStartNs = null;
    }
  });

  pi.on("after_provider_response", async () => {
    if (requestStartNs === null) return;
    const startNs = requestStartNs;
    requestStartNs = null; // consumed

    // Use hrtime.bigint for both sides — all in nanoseconds.
    const nowNs = process.hrtime.bigint();
    const holdS = Number(nowNs - startNs) / 1_000_000_000;

    if (holdS < 0.2) return; // noise threshold
    lastHoldSec = holdS;
  });

  pi.on("message_start", async ({ message }) => {
    if (!lastHoldSec) return;
    if (message.role !== "assistant") return;
    if (!(message as any).content || !(message as any).content.length) return;

    const holdAnn: TextContent = {
      type: "text",
      text: `(held ${formatHold(lastHoldSec)}) `,
    };
    (message as any).content.unshift(holdAnn);
    lastHoldSec = null;
  });
}
