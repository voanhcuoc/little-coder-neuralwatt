import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Text } from "@earendil-works/pi-tui";

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
 * Convert seconds to a human-readable hold duration.
 * e.g. 0.5 → "500ms", 3.2 → "3.2s", 65 → "1m 5s"
 */
function formatHold(sec: number): string {
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/**
 * Build a dim annotation component to render hold-time info in the scrollable
 * transcript as a CustomEntry — visible in TUI but never injected into LLM
 * context.
 */
function holdAnnotationComponent(
  holdSec: number,
  theme: Theme,
): Component {
  const box = new Box(0, 0);
  box.addChild(
    new Text(theme.fg("dim", `(held ${formatHold(holdSec)})`), 0, 0),
  );
  return box;
}

export default function (pi: ExtensionAPI) {
  const entryCustomType = "nw-flex-hold";

  // Register a custom renderer that displays hold-time annotations in the
  // scrollable message area without ever touching LLM context.
  pi.registerEntryRenderer(entryCustomType, (entry, _options, theme) => {
    const data = entry.data as { holdSec: number } | undefined;
    if (!data || data.holdSec < 0.2) return undefined;
    return holdAnnotationComponent(data.holdSec, theme);
  });

  // Per-request timing. Events fire sequentially:
  //   before_provider_request → after_provider_response → message_start → message_end
  let requestStartNs: bigint | null = null;

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

  // --- Per-request hooks: measure hold time, inject annotation into scroll ---

  /** Record request start time when flex tier is active. */
  pi.on("before_provider_request", async (event) => {
    const payload = (event as any).payload;
    const tier = getTier();
    if (tier === "flex") {
      requestStartNs = BigInt(process.hrtime.bigint());
    } else {
      requestStartNs = null;
    }
    return injectServiceTier(payload, tier);
  });

  /**
   * Compute hold time from wall-clock delta and annotate the scroll.
   *
   * Neuralwatt flex tier holds the HTTP connection open with keepalive frames
   * until capacity opens up, then starts the stream. There is NO server-side
   * hold-time or queue-time field in the response, headers, or SSE stream
   * (confirmed by reading the OpenAPI spec, streaming guide, and flex tier
   * docs — portal.neuralwatt.com/docs/guides/flex-tier).
   *
   * The gateway tracks `ttft` (time-to-first-token) server-side — visible in
   * the /v1/usage/requests per-request API — but it is NOT echoed in the
   * inference response. We measure it live: the delta from `before_provider`
   * request to `after_provider_response` is the client-side hold duration.
   *
   * The hold annotation is appended as a CustomEntry registered via
   * `registerEntryRenderer`, so it renders in the TUI scrollable area but
   * is never injected into buildSessionContext() → never touches LLM context.
   */
  pi.on("after_provider_response", async (_, ctx) => {
    if (requestStartNs === null) return;
    requestStartNs = null; // consumed

    const holdS =
      (Date.now() - Number(requestStartNs) / 1_000_000) / 1000;
    if (holdS < 0.2) return; // noise threshold

    // CustomEntry: visible in TUI scroll, NOT in LLM conversation context.
    ctx.appendEntry(entryCustomType, { holdSec: holdS });
  });
}
