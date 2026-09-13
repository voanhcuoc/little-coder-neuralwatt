// ============================================================================
// Energy pricing — display Neuralwatt per-request energy + cost.
// Disabled: token parsing from response stream causes connection issues.
// ============================================================================

const NW_ORIGIN = "https://api.neuralwatt.com";
const CACHE_DIR = __dirname;
const RATE_FILE = path.join(CACHE_DIR, ".vnd-rate.json");
const RATE_TIMESTAMP_FILE = path.join(CACHE_DIR, ".vnd-rate-attempt");
const LOCK_FILE = path.join(CACHE_DIR, ".rate-lock");
const RATE_TTL_MS = 24 * 60 * 60 * 1000;

let lastEnergy: {
  joules: number;
  kwh: number;
  request_cost_usd: number;
} | null = null;

let vndRate: number | null = null;
let lastFetchTime: number | 0 = 0;
let lastRibbonText: string = "";

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

  pi.on("message_end", (_event) => {
    if (!lastEnergy || lastEnergy.joules <= 0) return;
    void getVND();
    const parts = [
      `${formatEnergyWh(lastEnergy.joules)}`,
      `${formatEnergyJ(lastEnergy.joules)}`,
      `${formatCost(lastEnergy.request_cost_usd)}`,
    ];
    if (vndRate !== null && lastEnergy.request_cost_usd > 0) {
      parts.push(formatVND(lastEnergy.request_cost_usd, vndRate));
    }
    const ribbonText = `⚡ ${parts.join(" · ")}`;
    if (ribbonText === lastRibbonText) return;
    lastRibbonText = ribbonText;
    pi.appendEntry<CostRibbonData>("nw-energy", { text: ribbonText });
  });
}
