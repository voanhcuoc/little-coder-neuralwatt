import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box as BoxClass, Text as TextClass } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";

// ============================================================================
// Energy pricing — display Neuralwatt per-request energy + cost.
// Disabled: token parsing from response stream causes connection issues.
// ============================================================================

const NW_ORIGIN = "https://api.neuralwatt.com";
const CACHE_DIR = os.homedir() + "/.config/little-coder/extensions/energy-pricing";
const RATE_FILE = CACHE_DIR + "/.vnd-rate.json";
const RATE_TIMESTAMP_FILE = CACHE_DIR + "/.vnd-rate-attempt";
const LOCK_FILE = CACHE_DIR + "/.rate-lock";
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

let lastEnergy: {
  joules: number;
  kwh: number;
  request_cost_usd: number;
} | null = null;

let lastTokens: {
  input: number;
  cacheRead: number;
  output: number;
  totalTokens: number;
  tokenCostUsd: number;
} | null = null;

let vndRate: number | null = null;
let lastFetchTime: number | 0 = 0;
let lastRibbonText: string = "";

/** Running accumulator across all messages/turns until agent settles. */
let turnTotals: {
  totalInput: number;
  totalCache: number;
  totalOutput: number;
  totalTokenCost: number;
  totalEnergyJ: number;
  totalEnergyCostUsd: number;
  summaryShown: boolean;
} | null = null;

interface RateCache {
  rate: number;
  fetchedAt: string;
}

function loadCachedRate(): RateCache | null {
  try {
    const raw = fs.readFileSync(RATE_FILE, "utf-8");
    const parsed: RateCache = JSON.parse(raw);
    if (parsed.rate > 0) return parsed;
  } catch {}
  return null;
}

function saveCachedRate(rate: number): void {
  try {
    const tmp = RATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ rate, fetchedAt: new Date().toISOString() }));
    fs.renameSync(tmp, RATE_FILE);
  } catch {}
}

function loadAttemptTimestamp(): number | null {
  try {
    const raw = fs.readFileSync(RATE_TIMESTAMP_FILE, "utf-8");
    const ms = Number(raw);
    return isFinite(ms) ? ms : null;
  } catch { return null; }
}

function saveAttemptTimestamp(): void {
  try {
    const tmp = RATE_TIMESTAMP_FILE + ".tmp";
    fs.writeFileSync(tmp, String(Date.now()));
    fs.renameSync(tmp, RATE_TIMESTAMP_FILE);
  } catch {}
}

function tryAcquireLock(): boolean {
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); return true; }
  catch { return false; }
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

async function getVND(): Promise<number | null> {
  if (vndRate !== null && Date.now() - lastFetchTime < RATE_TTL_MS) {
    return vndRate;
  }
  const cached = loadCachedRate();
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < RATE_TTL_MS) {
    vndRate = cached.rate;
    lastFetchTime = Date.now();
    return cached.rate;
  }
  const lastAttempt = loadAttemptTimestamp();
  if (lastAttempt && Date.now() - lastAttempt < RATE_TTL_MS) {
    const fresh = loadCachedRate();
    if (fresh) {
      vndRate = fresh.rate;
      lastFetchTime = Date.now();
      return fresh.rate;
    }
    return null;
  }
  saveAttemptTimestamp();
  if (tryAcquireLock()) {
    try {
      const resp = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
      if (resp.ok) {
        const data = await resp.json();
        const rate = data.rates.VND;
        if (rate > 0) {
          saveCachedRate(rate);
          vndRate = rate;
          lastFetchTime = Date.now();
          return rate;
        }
      }
    } catch {}
    finally { releaseLock(); }
  } else {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const fresh = loadCachedRate();
      if (fresh) {
        vndRate = fresh.rate;
        lastFetchTime = Date.now();
        return fresh.rate;
      }
    }
  }
  return cached?.rate ?? null;
}

function formatEnergyJ(joules: number): string {
  if (joules < 0.001) return `${(joules * 1_000_000).toFixed(1)} µJ`;
  if (joules < 1) return `${(joules * 1000).toFixed(1)} mJ`;
  if (joules < 1_000) return `${joules.toFixed(1)} J`;
  return `${(joules / 1_000).toFixed(2)} kJ`;
}

function formatEnergyWh(joules: number): string {
  const wh = joules / 3_600;
  if (wh >= 1) return `${wh.toFixed(3)} Wh`;
  if (wh >= 0.001) return `${(wh * 1000).toFixed(2)} mWh`;
  return `${(wh * 1_000_000).toFixed(1)} µWh`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `${usd.toFixed(5)} USD (under 1 cent)`;
  if (usd < 1) return `${usd.toFixed(3)} USD (${Math.round(usd * 100)} cent)`;
  return `${usd.toFixed(2)} USD`;
}

interface CostRibbonData {
  text: string;
}

/** Format token breakdown: "(4,000 in · 6,000 cache · 2,000 out · 0.13 USD)". */
function formatTokenBreakdown(inputT: number, cacheT: number, outputT: number, tokenCostUsd: number): string {
  const inStr = inputT.toLocaleString();
  const cacheStr = cacheT.toLocaleString();
  const outStr = outputT.toLocaleString();
  // No nested parens inside the cost field
  let costStr: string;
  if (tokenCostUsd < 0.0001) costStr = `${tokenCostUsd.toFixed(6)} USD`;
  else if (tokenCostUsd < 0.01) costStr = `${tokenCostUsd.toFixed(4)} USD`;
  else costStr = `${tokenCostUsd.toFixed(2)} USD`;
  return `(${inStr} · ${cacheStr} · ${outStr} · ${costStr})`;
}

/** Format turn-summary token breakdown: "(4,000 in · 75% cache · 2,000 out · 0.35 USD)". */
function formatTurnSummary(inputT: number, cacheT: number, outputT: number, tokenCostUsd: number): string {
  const inStr = inputT.toLocaleString();
  const outStr = outputT.toLocaleString();
  const totalInput = inputT + cacheT;
  const cachePct = totalInput > 0 ? Math.round(cacheT / totalInput * 100) : 0;
  let costStr: string;
  if (tokenCostUsd < 0.0001) costStr = `${tokenCostUsd.toFixed(6)} USD`;
  else if (tokenCostUsd < 0.01) costStr = `${tokenCostUsd.toFixed(4)} USD`;
  else costStr = `${tokenCostUsd.toFixed(2)} USD`;
  return `(${inStr} · ${cachePct}% cache · ${outStr} · ${costStr})`;
}

function formatVND(usd: number, rate: number): string {
  const vnd = usd * rate;
  if (vnd === 0) return "0 VND";
  if (vnd < 1) return `${vnd.toFixed(3)} VND`;
  return `${Math.round(vnd)} VND`;
}

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
  } catch { /* SDK may abort the tee; best-effort */ }
  finally { reader.releaseLock(); }
}

function parseSseComment(line: string): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith(": ")) return;
  try {
    if (trimmed.startsWith(": energy ")) {
      const obj = JSON.parse(trimmed.slice(9)) as { energy_joules?: number; energy_kwh?: number };
      if (lastEnergy?.joules === obj.energy_joules) return;
      lastEnergy = {
        joules: obj.energy_joules ?? lastEnergy?.joules ?? 0,
        kwh: obj.energy_kwh ?? lastEnergy?.kwh ?? 0,
        request_cost_usd: lastEnergy?.request_cost_usd ?? 0,
      };
    } else if (trimmed.startsWith(": cost ")) {
      const obj = JSON.parse(trimmed.slice(7)) as { request_cost_usd?: number };
      if (!lastEnergy) return;
      lastEnergy.request_cost_usd = obj.request_cost_usd ?? 0;
    }
  } catch {} // malformed; ignore
}

let fetchWrapped = false;

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<CostRibbonData>("nw-energy", (entry, _opts, theme) => {
    const text = entry.data?.text;
    if (!text) return undefined;
    const box = new BoxClass(2, 1);
    box.addChild(new TextClass(theme.fg("dim", text), 1, 0));
    return box;
  });

  if (!fetchWrapped) {
    fetchWrapped = true;
    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(NW_ORIGIN + "/v1/chat/completions")) return originalFetch(input, init);
      const response = await originalFetch(input, init);
      if (response.ok && response.body) {
        const [sdkBody, quotaBody] = response.body.tee();
        void captureSseComments(quotaBody, parseSseComment);
        return new Response(sdkBody, { headers: response.headers, status: response.status, statusText: response.statusText });
      }
      return response;
    };
    globalThis.fetch = wrappedFetch;
  }

  const initialCache = loadCachedRate();
  if (initialCache) {
    vndRate = initialCache.rate;
    lastFetchTime = Date.now();
  }
  void getVND();

  pi.on("message_end", (event: any) => {
    // Extract token data from SDK event (not from raw stream parsing)
    const msg = event?.message;
    const usage = msg?.usage;
    if (usage && typeof usage === "object") {
      lastTokens = {
        input: (usage.input as number) ?? 0,
        cacheRead: (usage.cacheRead as number) ?? 0,
        output: (usage.output as number) ?? 0,
        totalTokens: (usage.totalTokens as number) ?? 0,
        tokenCostUsd: (usage.cost?.total as number) ?? 0,
      };

      // Always accumulate tokens (even for tool-result messages with no energy)
      if (!turnTotals) {
        turnTotals = { totalInput: 0, totalCache: 0, totalOutput: 0, totalTokenCost: 0, totalEnergyJ: 0, totalEnergyCostUsd: 0, summaryShown: false };
      }
      turnTotals.totalInput += lastTokens.input;
      turnTotals.totalCache += lastTokens.cacheRead;
      turnTotals.totalOutput += lastTokens.output;
      turnTotals.totalTokenCost += lastTokens.tokenCostUsd;

      // Energy data only available for LLM-assisted (not pure tool-result) messages
      if (lastEnergy && lastEnergy.joules > 0) {
        turnTotals.totalEnergyJ += lastEnergy.joules;
        turnTotals.totalEnergyCostUsd += lastEnergy.request_cost_usd;

        void getVND();
        const parts = [
          `${formatEnergyWh(lastEnergy.joules)}`,
          `${formatEnergyJ(lastEnergy.joules)}`,
          `${formatCost(lastEnergy.request_cost_usd)}`,
        ];
        if (vndRate !== null && lastEnergy.request_cost_usd > 0) {
          parts.push(formatVND(lastEnergy.request_cost_usd, vndRate));
        }
        // Token breakdown
        if (lastTokens) {
          parts.push(formatTokenBreakdown(lastTokens.input, lastTokens.cacheRead, lastTokens.output, lastTokens.tokenCostUsd));
        }
        const ribbonText = `⚡ ${parts.join(" · ")}`;
        if (ribbonText === lastRibbonText) return;
        lastRibbonText = ribbonText;
        pi.appendEntry<CostRibbonData>("nw-energy", { text: ribbonText });
      }
    }
  });

  // Grand summary when agent fully settles (done processing, waiting for user)
  pi.on("agent_settled", () => {
    if (!turnTotals || turnTotals.summaryShown) return;
    turnTotals.summaryShown = true;
    const summaryText = formatTurnSummary(turnTotals.totalInput, turnTotals.totalCache, turnTotals.totalOutput, turnTotals.totalTokenCost);
    const energyWh = formatEnergyWh(turnTotals.totalEnergyJ);
    const energyJ = formatEnergyJ(turnTotals.totalEnergyJ);
    const energyCost = formatCost(turnTotals.totalEnergyCostUsd);
    const vndText = vndRate != null && turnTotals.totalEnergyCostUsd > 0 ? formatVND(turnTotals.totalEnergyCostUsd, vndRate) : "";
    const fullText = `⚡ Agent summary: ${energyWh} · ${energyJ} · ${energyCost}${vndText ? ` · ${vndText}` : ``} · ${summaryText}`;
    lastRibbonText = fullText;
    pi.appendEntry<CostRibbonData>("nw-energy", { text: fullText });
    // Reset for next agent run
    turnTotals = null;
  });
}
