import type { ExtensionAPI, AgentMessage } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Energy pricing — show J / Wh, USD, VND per response
// ============================================================================

const USD_KWH = 10.0; // flat $/kWh for energy pricing
const ENERGY_J_KEY = "energy";

/**
 * Per-model average energy (mWh) by prompt-size band.
 * Sourced from portal.neuralwatt.com/energy-pricing (7-day trailing).
 * Keys match the `id` field in models.json.
 */
const MODEL_ENERGY: Record<string, Record<string, number>> = {
  "qwen3.6-35b": {
    "0-256": 15.12,
    "256-1k": 64.33,
    "1k-4k": 55.67,
    "4k-16k": 67.60,
    "16k-64k": 72.35,
    "64k-256k": 93.25,
  },
  "qwen-3.8-27b": {
    "0-256": 9.34,
    "256-1k": 18.18,
    "1k-4k": 43.20,
    "4k-16k": 114.87,
    "16k-64k": 630.26,
    "64k-256k": 901.13,
  },
};

/**
 * Model name fallback (without provider prefix) → energy data.
 * Also covers variations like "neuralwatt/qwen3.6-35b".
 */
function resolveModelKey(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  // Strip provider prefix (e.g. "neuralwatt/qwen3.6-35b" → "qwen3.6-35b")
  const base = modelId.split("/").pop() ?? modelId;
  if (MODEL_ENERGY[base]) return base;
  // Try matching known model IDs as substrings
  for (const key of Object.keys(MODEL_ENERGY)) {
    if (base.includes(key) || key.includes(base)) return key;
  }
  return undefined;
}

function promptSizeBand(promptTokens: number): string {
  if (promptTokens <= 256) return "0-256";
  if (promptTokens <= 1000) return "256-1k";
  if (promptTokens <= 4000) return "1k-4k";
  if (promptTokens <= 16000) return "4k-16k";
  if (promptTokens <= 64000) return "16k-64k";
  return "64k-256k";
}

function formatEnergy(mWh: number): string {
  if (mWh < 1) {
    return `${(mWh * 1000).toFixed(1)} µWh`;
  }
  if (mWh >= 1000) {
    return `${(mWh / 1000).toFixed(3)} Wh`;
  }
  return `${mWh.toFixed(1)} mWh`;
}

function formatEnergyJoules(mWh: number): string {
  const joules = mWh * 3.6;
  if (joules < 1) {
    return `${(joules * 1000).toFixed(1)} mJ`;
  }
  return `${joules.toFixed(2)} J`;
}

function formatUSD(usd: number): string {
  if (usd < 0.0001) return `$<0.0001`;
  return `$${usd.toFixed(4)}`;
}

let cachedVNDRate: number | null = null;
let lastRateFetch: number = 0;
const VND_RATE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — daily enough

async function getVNDRate(): Promise<number> {
  const now = Date.now();
  if (cachedVNDRate && now - lastRateFetch < VND_RATE_TTL_MS) {
    return cachedVNDRate;
  }
  try {
    const resp = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    if (resp.ok) {
      const data = await resp.json();
      cachedVNDRate = data.rates.VND;
      lastRateFetch = now;
      return cachedVNDRate;
    }
  } catch {
    /* fallback below */
  }
  // Fallback: known recent rate (~25,700 VND/USD)
  // Cached to avoid repeated failed fetches today
  cachedVNDRate = 25700;
  lastRateFetch = now;
  return cachedVNDRate;
}

function formatVND(usd: number, rate: number): string {
  const vnd = usd * rate;
  if (vnd < 1) return `₫${(vnd * 1000).toFixed(0)}`;
  return `₫${vnd.toLocaleString("vi-VN", { maximumFractionDigits: 0 })}`;
}

function energyForModel(modelId: string | undefined, promptTokens: number): number | undefined {
  const key = resolveModelKey(modelId);
  if (!key) return undefined;
  const band = promptSizeBand(promptTokens);
  return MODEL_ENERGY[key][band] ?? MODEL_ENERGY[key]["4k-16k"];
}

export default function (pi: ExtensionAPI) {
  let currentModel: string | undefined;
  let vndRate: number = 25700; // default

  // Fetch VND rate at startup
  getVNDRate().then((r) => { vndRate = r; });

  pi.on("before_provider_request", async (event) => {
    const p = (event as any).payload;
    if (p && typeof p === "object") {
      currentModel = (p as any).model;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg?.role !== "assistant") return;
    if (!currentModel || currentModel.includes("anthropic")) return;

    const usage = (msg as any).usage as { input?: number; output?: number } | undefined;
    if (!usage || !usage.input) return;

    const mWh = energyForModel(currentModel, usage.input);
    if (mWh === undefined) return;

    const costUSD = (mWh / 1000) * USD_KWH;
    vndRate = await getVNDRate();

    // Format: "🔋 72.4 mWh (260.6 J) · $0.0007 · ₫18,000"
    const line = `🔋 ${formatEnergy(mWh)} (${formatEnergyJoules(mWh)}) · ${formatUSD(costUSD)} · ${formatVND(costUSD, vndRate)}`;
    ctx.ui.setStatus(ENERGY_J_KEY, line);
  });
}
