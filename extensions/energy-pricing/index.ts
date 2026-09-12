import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Energy pricing — display Neuralwatt per-request energy + cost in footer
//
// Neuralwatt sends energy & cost data via SSE comments in every stream:
//   : energy {"energy_joules": ..., "energy_kwh": ...}
//   : cost   {"request_cost_usd": ..., ...}
//
// We override `fetch` to intercept the response body, tee it, and parse
// those comments in a background reader. The latest energy/cost pair is
// stored in a module-level variable and displayed on `message_end`.
// ============================================================================

const NW_ORIGIN = "https://api.neuralwatt.com";

let lastEnergy: {
  joules: number;
  kwh: number;
  request_cost_usd: number;
} | null = null;

let vndRate: number | null = null;

function formatEnergyJ(joules: number): string {
  if (joules < 0.001) return `${(joules * 1_000_000).toFixed(1)} µJ`;
  if (joules < 1) return `${(joules * 1_000).toFixed(1)} mJ`;
  if (joules < 1_000) return `${joules.toFixed(1)} J`;
  return `${(joules / 1_000).toFixed(2)} kJ`;
}

function formatEnergyWh(joules: number): string {
  const wh = joules / 3_600;
  if (wh >= 1) return `${wh.toFixed(3)} Wh`;
  if (wh >= 0.001) return `${(wh * 1_000).toFixed(2)} mWh`;
  return `${(wh * 1_000_000).toFixed(1)} µWh`;
}

function formatCost(usd: number): string {
  if (usd < 0.00001) return `$<0.00001`;
  return `$${usd.toFixed(5)}`;
}

function formatVND(usd: number, rate: number): string {
  const vnd = usd * rate;
  if (vnd < 1) return `₫${(vnd * 1_000).toFixed(0)}`;
  return `₫${vnd.toLocaleString("vi-VN", { maximumFractionDigits: 0 })}`;
}

async function fetchVND(): Promise<void> {
  try {
    const resp = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    if (resp.ok) {
      const data = await resp.json();
      vndRate = data.rates.VND;
    }
  } catch {
    // VND stays null; we just omit it from display
  }
}

/** Parse SSE comments from the response body stream. */
async function captureSseComments(
  body: ReadableStream<Uint8Array>,
  onComment: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onComment(line);
    }
    const remaining = (buffer + decoder.decode(new Uint8Array(0), false)).trim();
    if (remaining) onComment(remaining);
  } catch {
    // SDK may abort the tee; best-effort
  } finally {
    reader.releaseLock();
  }
}

function parseSseComment(line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith(": ")) return;

  try {
    if (trimmed.startsWith(": energy ")) {
      const obj = JSON.parse(trimmed.slice(9)) as {
        energy_joules?: number;
        energy_kwh?: number;
      };
      if (lastEnergy?.joules === obj.energy_joules) return; // dedup
      // If we already have a cost, keep it
      lastEnergy = {
        joules: obj.energy_joules ?? lastEnergy?.joules ?? 0,
        kwh: obj.energy_kwh ?? lastEnergy?.kwh ?? 0,
        request_cost_usd: lastEnergy?.request_cost_usd ?? 0,
      };
    } else if (trimmed.startsWith(": cost ")) {
      const obj = JSON.parse(trimmed.slice(7)) as {
        request_cost_usd?: number;
      };
      if (!lastEnergy) return;
      lastEnergy.request_cost_usd = obj.request_cost_usd ?? 0;
    }
  } catch {
    // Malformed SSE comment; ignore
  }
}

// Telemetry: track how many times we've already wrapped fetch to avoid double-wrapping
let fetchWrapped = false;

export default function (pi: ExtensionAPI) {
  // Kick off VND fetch at startup
  fetchVND();

  // Wrap fetch ONCE
  if (!fetchWrapped) {
    fetchWrapped = true;
    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      // Only intercept Neuralwatt chat completions
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(NW_ORIGIN + "/v1/chat/completions")) return originalFetch(input, init);

      const response = await originalFetch(input, init);

      if (response.ok && response.body) {
        const [sdkBody, quotaBody] = response.body.tee();
        // Read SSE comments in background (best-effort)
        void captureSseComments(quotaBody, parseSseComment);
        return new Response(sdkBody, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      }

      return response;
    };
    globalThis.fetch = wrappedFetch;
  }

  pi.on("message_end", (_event, ctx) => {
    if (!lastEnergy || lastEnergy.joules <= 0) return;

    const parts: string[] = [];
    parts.push(`⚡ ${formatEnergyWh(lastEnergy.joules)}`);
    parts.push(`(${formatEnergyJ(lastEnergy.joules)})`);
    parts.push(formatCost(lastEnergy.request_cost_usd));

    if (vndRate !== null && lastEnergy.request_cost_usd > 0) {
      parts.push(formatVND(lastEnergy.request_cost_usd, vndRate));
    }

    ctx.ui.setStatus("nw-energy", parts.join(" "));
  });
}
