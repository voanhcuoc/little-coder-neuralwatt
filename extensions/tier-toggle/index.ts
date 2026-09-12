import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function (pi: ExtensionAPI) {
  // Per-request timing. Events fire sequentially:
  //   before_provider_request → after_provider_response → message_start → message_end → agent_end
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

  // --- Per-request lifetime hooks (TUI status bar only — never touches message content) ---

  /** Record request start and show initial "waiting" status for flex tier. */
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
   * Compute hold time from wall-clock delta and display in the TUI status bar.
   *
   * Neuralwatt flex tier keeps the HTTP connection open with keepalive frames
   * until capacity opens up, then starts the stream. There is NO server-side
   * hold-time field in the response, headers, or SSE stream (confirmed by
   * reading the OpenAPI spec, streaming guide, and flex tier docs).
   *
   * The gateway tracks `ttft` (time-to-first-token) server-side — visible in
   * the /v1/usage/requests per-request log — but it is not echoed in the
   * inference response. We measure it live: the delta between request send and
   * the first byte of the stream is the client-side hold duration.
   */
  pi.on("message_start", async (_event, ctx) => {
    if (requestStartNs === null) return;
    requestStartNs = null; // consumed

    const holdS = (Date.now() - Number(requestStartNs) / 1_000_000) / 1000;
    // Don't pollute the footer for negligible delays
    if (holdS < 0.2) return;

    ctx.ui.setStatus("flex", `⏸ ${formatHold(holdS)} hold`);
  });

  /** Clear the flex status when the entire agent turn finishes. */
  pi.on("agent_end", async (_, ctx) => {
    ctx.ui.setStatus("flex", undefined);
  });
}
