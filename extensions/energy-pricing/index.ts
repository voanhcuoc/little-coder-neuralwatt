import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box as BoxClass, Text as TextClass } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Energy pricing — display Neuralwatt per-request energy + cost in scroll area
// as a CustomEntry annotation (zero context pollution).
//
// Injected at `message_end` via `pi.appendEntry("nw-energy", data)`.
// The renderer produces a dim, inline ribbon before the assistant's response.
//

//
// Neuralwatt sends energy & cost data via SSE comments in every stream:
//   : energy {"energy_joules": ..., "energy_kwh": ...}
//   : cost   {"request_cost_usd": ..., ...}
//
// We override `fetch` to intercept the response body, tee it, and parse
// those comments in a background reader. The latest energy/cost pair is
// stored in a module-level variable and displayed on `message_end`.
//
// VND exchange rate: shared disk cache (~24h TTL, file-lock to prevent
// multiple sessions from hammering the API simultaneously).
// ============================================================================

const NW_ORIGIN = "https://api.neuralwatt.com";
const CACHE_DIR = __dirname;
const RATE_FILE = path.join(CACHE_DIR, ".vnd-rate.json");
const RATE_TIMESTAMP_FILE = path.join(CACHE_DIR, ".vnd-rate-attempt");
const LOCK_FILE = path.join(CACHE_DIR, ".rate-lock");
const RATE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const POLL_INTERVAL_MS = 1500;

let lastEnergy: {
  joules: number;
  kwh: number;
  request_cost_usd: number;
} | null = null;

let vndRate: number | null = null;
let lastFetchTime: number | 0 = 0;
let lastRibbonText: string = "";

// ---------- VND rate: disk cache + file lock ----------

interface RateCache {
  rate: number;
  fetchedAt: string;
}

function loadCachedRate(): RateCache | null {
  try {
    const raw = fs.readFileSync(RATE_FILE, "utf-8");
    const parsed: RateCache = JSON.parse(raw);
    if (parsed.rate > 0) return parsed;
  } catch {
    // No cache yet
  }
  return null;
}

function saveCachedRate(rate: number): void {
  try {
    const cache: RateCache = { rate, fetchedAt: new Date().toISOString() };
    // Atomic write via tmp + rename
    const tmp = RATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, RATE_FILE);
  } catch {
    // Best-effort
  }
}

// Attempt timestamp — cross-process gate. At most one fetch
// attempt per TTL window regardless of how many processes call.
function loadAttemptTimestamp(): number | null {
  try {
    const raw = fs.readFileSync(RATE_TIMESTAMP_FILE, "utf-8");
    const ms = Number(raw);
    return isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function saveAttemptTimestamp(): void {
  try {
    // Atomic write
    const tmp = RATE_TIMESTAMP_FILE + ".tmp";
    fs.writeFileSync(tmp, String(Date.now()));
    fs.renameSync(tmp, RATE_TIMESTAMP_FILE);
  } catch {
    // Non-critical; another process will handle it
  }
}

function tryAcquireLock(): boolean {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Already gone
  }
}

/**
 * Fetch or return cached VND rate.
 * - Fresh cache → return immediately.
 * - Stale cache → try to fetch (with file lock so only one session hits the API).
 * - Contention → poll the cache file until it's written, then return.
 * - Failure → fall back to cached value (even if stale) or null.
 */
async function getVND(): Promise<number | null> {
  // In-memory guard — vndRate is the single source of truth in a live session.
  if (vndRate !== null && Date.now() - lastFetchTime < RATE_TTL_MS) {
    return vndRate;
  }

  // Cross-process guard — disk-based attempt timestamp.
  // Prevents more than one fetch attempt per TTL window,
  // regardless of how many processes call us concurrently.
  const cached = loadCachedRate();
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < RATE_TTL_MS) {
    vndRate = cached.rate;
    lastFetchTime = Date.now();
    return cached.rate;
  }

  const lastAttempt = loadAttemptTimestamp();
  if (lastAttempt && Date.now() - lastAttempt < RATE_TTL_MS) {
    // We're within the TTL window — another process already started fetching.
    // Either the cache got updated (poll for it) or the attempt failed
    // (return null / stale). In either case, don't trigger another fetch.
    const fresh = loadCachedRate();
    if (fresh) {
      vndRate = fresh.rate;
      lastFetchTime = Date.now();
      return fresh.rate;
    }
    return null;
  }

  // Write attempt timestamp BEFORE acquiring lock — this is the
  // cross-process gate that prevents double-fetching.
  saveAttemptTimestamp();

  if (tryAcquireLock()) {
    // We got the lock — fetch for everyone and update the disk cache
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
    } catch {
      // Network error; fall through to stale cache
    } finally {
      releaseLock();
    }
  } else {
    // Another session holds the lock — poll the cache file until it appears
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const fresh = loadCachedRate();
      if (fresh) {
        vndRate = fresh.rate;
        lastFetchTime = Date.now();
        return fresh.rate;
      }
    }
  }

  // Fallback: stale cache or null
  return cached?.rate ?? null;
}

// ---------- Formatting ----------

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
  if (usd < 0.01) return `${usd.toFixed(5)} USD (under 1 cent)`;
  if (usd < 1) return `${usd.toFixed(3)} USD (${Math.round(usd * 100)} cent)`;
  return `${usd.toFixed(2)} USD`;
}

/** Cost ribbon rendered in the scroll area. */
interface CostRibbonData {
  text: string;
}

function formatVND(usd: number, rate: number): string {
  const vnd = usd * rate;
  if (vnd === 0) return "0 VND";
  if (vnd < 1) return `${vnd.toFixed(3)} VND`;
  return `${Math.round(vnd)} VND`;
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

// Extension entry point

let fetchWrapped = false;

export default function (pi: ExtensionAPI) {
  // Register custom scroll entry renderer for energy ribbon
  pi.registerEntryRenderer<CostRibbonData>("nw-energy", (entry, _opts, theme) => {
    const text = entry.data?.text;
    if (!text) return undefined;
    const box = new BoxClass(2, 1);
    box.addChild(new TextClass(theme.fg("dim", text), 1, 0));
    return box;
  });

  // Wrap fetch ONCE (per process)
  if (!fetchWrapped) {
    fetchWrapped = true;
    const originalFetch = globalThis.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(NW_ORIGIN + "/v1/chat/completions")) return originalFetch(input, init);

      const response = await originalFetch(input, init);

      if (response.ok && response.body) {
        const [sdkBody, quotaBody] = response.body.tee();
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

  // Load cached rate synchronously on startup
  const initialCache = loadCachedRate();
  if (initialCache) {
    vndRate = initialCache.rate;
    lastFetchTime = Date.now();
  }

  // Kick off async fetch (updates in-memory + disk cache)
  getVND().then((r) => {
    if (r) vndRate = r;
  });

  pi.on("message_end", (_event) => {
    if (!lastEnergy || lastEnergy.joules <= 0) return;

    // Refresh VND in background (per-call, guarded by disk cache).
    void getVND();

    const parts = [
      `${formatEnergyWh(lastEnergy.joules)}`,
      `${formatEnergyJ(lastEnergy.joules)}`,
      `${formatCost(lastEnergy.request_cost_usd)}`,
    ];

    // VND: include whenever fetch succeeded
    if (vndRate !== null && lastEnergy.request_cost_usd > 0) {
      parts.push(formatVND(lastEnergy.request_cost_usd, vndRate));
    }

    const ribbonText = `⚡ ${parts.join(" · ")}`;

    // Deduplicate: skip duplicate appendEntry within a short window
    // (message_end can fire multiple times per message, creating duplicate ribbons)
    if (ribbonText === lastRibbonText) return;
    lastRibbonText = ribbonText;

    // Inject cost ribbon into scroll as CustomEntry (zero LLM context pollution)
    pi.appendEntry<CostRibbonData>("nw-energy", { text: ribbonText });
  });
}
