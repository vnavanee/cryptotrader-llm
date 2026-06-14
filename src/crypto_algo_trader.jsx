import { useState, useEffect, useRef, useCallback, Component } from "react";

// ─── Error Boundary — shows readable crash message instead of blank screen ────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: "monospace", background: "#0f1117", color: "#e8eaf0", minHeight: "100vh" }}>
          <div style={{ color: "#ef4444", fontSize: 16, fontWeight: 700, marginBottom: 12 }}>⚠ Runtime error</div>
          <pre style={{ color: "#f59e0b", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.message}
          </pre>
          <pre style={{ color: "#555b73", fontSize: 11, marginTop: 12, whiteSpace: "pre-wrap" }}>
            {this.state.error.stack}
          </pre>
          <button onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: "8px 20px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────
const COINS = ["BTC", "ETH", "SOL"];
const COIN_COLORS = { BTC: "#f59e0b", ETH: "#6366f1", SOL: "#10b981" };
// Fallback baselines — used only if proxy is unreachable
const COIN_BASE = { BTC: 63000, ETH: 3000, SOL: 145 };
const PRODUCT_IDS = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD" };

// ─── Proxy config ─────────────────────────────────────────────────────────────
// After deploying coinbase-cors-proxy to Vercel, paste your deployment URL here.
// e.g. "https://coinbase-cors-proxy.vercel.app"
// Leave as empty string to stay in simulation-only mode.
const PROXY_BASE = "https://coinbaseticker-283150216453.europe-west1.run.app";

// ─── Public price fetch via proxy, with full diagnostics ──────────────────────
// Returns { price, ok, httpStatus, errorType, errorMsg, raw }
// errorType: "no_proxy" | "cors" | "network" | "http" | "parse" | "empty" | null
async function fetchPublicPriceDiag(productId) {
  const diag = { price: null, ok: false, httpStatus: null, errorType: null, errorMsg: null, raw: null };

  if (!PROXY_BASE) {
    diag.errorType = "no_proxy";
    diag.errorMsg = "No proxy URL configured — set PROXY_BASE in the source to your Vercel deployment.";
    return diag;
  }

  const url = `${PROXY_BASE}?product=${productId}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    diag.httpStatus = res.status;

    if (!res.ok) {
      diag.errorType = "http";
      diag.errorMsg = `Proxy returned HTTP ${res.status} ${res.statusText}`;
      return diag;
    }

    let payload;
    try {
      const text = await res.text();
      diag.raw = text.slice(0, 300);
      payload = JSON.parse(text);
    } catch (e) {
      diag.errorType = "parse";
      diag.errorMsg = `JSON parse failed: ${e.message}`;
      return diag;
    }

    // Proxy returns { data: { BTC: { price, bid, ask, ... } }, fetchedAt }
    const symbol = productId.replace("-USD", "");
    const coinData = payload?.data?.[symbol];
    const price = parseFloat(coinData?.price);

    if (!coinData || isNaN(price)) {
      diag.errorType = "empty";
      diag.errorMsg = payload?.errors?.[symbol]
        || `No price for ${symbol}. Proxy keys: ${Object.keys(payload?.data || {}).join(", ")}`;
      return diag;
    }

    diag.price = price;
    diag.bid = parseFloat(coinData.bid) || null;
    diag.ask = parseFloat(coinData.ask) || null;
    diag.volume = parseFloat(coinData.volume) || null;
    diag.ok = true;
    return diag;

  } catch (e) {
    const msg = e.message || String(e);
    diag.errorType = msg.toLowerCase().includes("cors") || msg.toLowerCase().includes("failed to fetch")
      ? "cors" : "network";
    diag.errorMsg = msg;
    return diag;
  }
}

// Batch fetch all coins via a single proxy call, return { prices, diags }
async function fetchAllPublicPrices() {
  if (!PROXY_BASE) {
    const diags = {};
    for (const coin of COINS) {
      diags[coin] = {
        price: null, ok: false, httpStatus: null,
        errorType: "no_proxy",
        errorMsg: "No proxy URL configured — set PROXY_BASE in the source to your Cloud Run function URL.",
        raw: null,
      };
    }
    return { prices: {}, diags };
  }

  // Single batched request: ?product=BTC-USD,ETH-USD,SOL-USD
  const productList = COINS.map((c) => PRODUCT_IDS[c]).join(",");
  const url = `${PROXY_BASE}?product=${productList}`;
  const diags = {};
  const prices = {};

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await res.text();

    if (!res.ok) {
      for (const coin of COINS) {
        diags[coin] = { price: null, ok: false, httpStatus: res.status, errorType: "http",
          errorMsg: `Proxy HTTP ${res.status}`, raw: text.slice(0, 200) };
      }
      return { prices, diags };
    }

    const payload = JSON.parse(text);

    for (const coin of COINS) {
      const coinData = payload?.data?.[coin];
      const price = parseFloat(coinData?.price);
      if (!coinData || isNaN(price)) {
        diags[coin] = {
          price: null, ok: false, httpStatus: res.status, errorType: "empty",
          errorMsg: payload?.errors?.[coin] || `${coin} missing from proxy response`,
          raw: text.slice(0, 200),
        };
      } else {
        prices[coin] = price;
        diags[coin] = {
          price, ok: true, httpStatus: res.status, errorType: null, errorMsg: null,
          bid: parseFloat(coinData.bid) || null,
          ask: parseFloat(coinData.ask) || null,
          volume: parseFloat(coinData.volume) || null,
        };
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    const errorType = msg.toLowerCase().includes("cors") || msg.toLowerCase().includes("failed to fetch")
      ? "cors" : "network";
    for (const coin of COINS) {
      diags[coin] = { price: null, ok: false, httpStatus: null, errorType, errorMsg: msg, raw: null };
    }
  }

  return { prices, diags };
}
const CB_API_BASE = "https://api.coinbase.com/api/v3/brokerage";

// Real news fetched from NewsData.io via the Cloud Run proxy
const NEWS_PROXY_URL = `${PROXY_BASE}/news`;

// ─── Technical Indicators ─────────────────────────────────────────────────────
function generatePrice(prev, volatility = 0.0015) {
  const change = (Math.random() - 0.499) * volatility * prev;
  return Math.max(prev + change, prev * 0.97);
}
function calcSMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = prices.slice(-period - 1).map((p, i, arr) => (i > 0 ? p - arr[i - 1] : 0)).slice(1);
  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map(Math.abs);
  const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / period : 0;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function calcBollinger(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std };
}
function calcMACD(prices) {
  const e12 = calcEMA(prices, 12), e26 = calcEMA(prices, 26);
  return e12 && e26 ? e12 - e26 : null;
}
// ─── Signal generation ───────────────────────────────────────────────────────
// Each indicator votes independently (+1 bull / -1 bear / 0 neutral).
// Confidence = % of available indicators that AGREE with the action direction.
// A BUY only fires when:
//   1. Score > 2  (net bullish weight)
//   2. At least MIN_AGREEING_INDICATORS indicators vote bullish
//   3. Confidence >= the user-set threshold (checked in runTick)
const MIN_AGREEING_INDICATORS = 3; // at least 3 of 5 must agree

function generateSignal(indicators, newsSentiment, volumeRatio) {
  // Each entry: { weight, vote: +1 bull | -1 bear | 0 neutral, reason, active }
  const signals = [];

  // ── RSI (weight 2) ────────────────────────────────────────────────────────
  if (indicators.rsi !== null) {
    if (indicators.rsi < 35)
      signals.push({ weight: 2, vote: 1,  label: `RSI oversold (${indicators.rsi.toFixed(1)})`, active: true });
    else if (indicators.rsi > 65)
      signals.push({ weight: 2, vote: -1, label: `RSI overbought (${indicators.rsi.toFixed(1)})`, active: true });
    else
      signals.push({ weight: 2, vote: 0,  label: `RSI neutral (${indicators.rsi.toFixed(1)})`, active: true });
  }

  // ── SMA crossover (weight 1.5) ────────────────────────────────────────────
  if (indicators.sma20 && indicators.sma50) {
    if (indicators.sma20 > indicators.sma50)
      signals.push({ weight: 1.5, vote: 1,  label: "SMA20 > SMA50 (bullish cross)", active: true });
    else
      signals.push({ weight: 1.5, vote: -1, label: "SMA20 < SMA50 (bearish cross)", active: true });
  }

  // ── MACD (weight 1) ───────────────────────────────────────────────────────
  if (indicators.macd !== null) {
    if (indicators.macd > 0)
      signals.push({ weight: 1, vote: 1,  label: `MACD positive (${indicators.macd.toFixed(2)})`, active: true });
    else
      signals.push({ weight: 1, vote: -1, label: `MACD negative (${indicators.macd.toFixed(2)})`, active: true });
  }

  // ── Bollinger Bands (weight 2) ────────────────────────────────────────────
  if (indicators.boll && indicators.currentPrice) {
    if (indicators.currentPrice < indicators.boll.lower)
      signals.push({ weight: 2, vote: 1,  label: "Price below BB lower band", active: true });
    else if (indicators.currentPrice > indicators.boll.upper)
      signals.push({ weight: 2, vote: -1, label: "Price above BB upper band", active: true });
    else
      signals.push({ weight: 2, vote: 0,  label: "Price inside BB bands", active: true });
  }

  // ── News sentiment (weight 1.5) ───────────────────────────────────────────
  if (newsSentiment > 0.15)
    signals.push({ weight: 1.5, vote: 1,  label: `Positive news sentiment (${(newsSentiment * 100).toFixed(0)}%)`, active: true });
  else if (newsSentiment < -0.15)
    signals.push({ weight: 1.5, vote: -1, label: `Negative news sentiment (${(newsSentiment * 100).toFixed(0)}%)`, active: true });
  else
    signals.push({ weight: 1.5, vote: 0,  label: `Neutral news (${(newsSentiment * 100).toFixed(0)}%)`, active: true });

  // ── Weighted score ────────────────────────────────────────────────────────
  let score = signals.reduce((sum, s) => sum + s.vote * s.weight, 0);

  // Volume multiplier — amplifies or dampens but cannot flip direction
  let volumeNote = "";
  if (volumeRatio > 1.4) {
    score *= 1.2;
    volumeNote = `High volume (${volumeRatio.toFixed(2)}x) — signal amplified`;
  } else if (volumeRatio < 0.7) {
    score *= 0.6;
    volumeNote = `Low volume (${volumeRatio.toFixed(2)}x) — signal dampened`;
  }

  // ── Confidence: % of non-neutral indicators agreeing with net direction ───
  // Only counts indicators with an actual vote (not 0)
  const activeSignals = signals.filter((s) => s.vote !== 0);
  const netDir = score > 0 ? 1 : -1;
  const agreeing = activeSignals.filter((s) => s.vote === netDir);
  // Confidence = (agreeing weight) / (total active weight) * 100
  const totalActiveWeight = activeSignals.reduce((s, i) => s + i.weight, 0);
  const agreeingWeight    = agreeing.reduce((s, i) => s + i.weight, 0);
  const confidence = totalActiveWeight > 0
    ? Math.min((agreeingWeight / totalActiveWeight) * 100, 99)
    : 0;

  // ── Action: BUY requires score threshold AND minimum agreeing indicators ──
  const agreeingCount = agreeing.length;
  let action = "HOLD";
  if (score > 2 && agreeingCount >= MIN_AGREEING_INDICATORS) action = "BUY";

  const reasons = [
    ...signals.map((s) => ({ label: s.label, vote: s.vote })),
    ...(volumeNote ? [{ label: volumeNote, vote: 0 }] : []),
  ];

  return {
    action,
    score: score.toFixed(2),
    confidence: confidence.toFixed(1),
    agreeingCount,
    totalIndicators: activeSignals.length,
    reasons,
  };
}

// ─── Rate Limiter + Exponential Backoff ───────────────────────────────────────
// Coinbase Advanced Trade limits: READ 600 req/10s, WRITE 500 req/10s.
// We track timestamps of recent calls in a sliding 10-second window.
// On 429 / 5xx we apply full exponential backoff with jitter (capped at 32s).

const RATE_LIMITS = { READ: { max: 600, windowMs: 10_000 }, WRITE: { max: 500, windowMs: 10_000 } };
const MAX_RETRIES = 6;
const BASE_DELAY_MS = 250;   // first backoff step
const MAX_BACKOFF_MS = 32_000;

// Shared mutable state for rate-limit windows (module-level, not React state)
const _rl = {
  READ:  { timestamps: [] },
  WRITE: { timestamps: [] },
  // Observable counters — React components read these via a ref + polling
  stats: { readUsed: 0, writeUsed: 0, readQueued: 0, writeQueued: 0, retries: 0, throttled: 0, lastError: null },
};

function _pruneWindow(bucket) {
  const cutoff = Date.now() - RATE_LIMITS[bucket].windowMs;
  _rl[bucket].timestamps = _rl[bucket].timestamps.filter((t) => t > cutoff);
}

function _windowUsed(bucket) {
  _pruneWindow(bucket);
  return _rl[bucket].timestamps.length;
}

// Returns ms to wait before the next slot opens (0 = fire now)
function _waitMs(bucket) {
  _pruneWindow(bucket);
  const { timestamps } = _rl[bucket];
  const { max, windowMs } = RATE_LIMITS[bucket];
  if (timestamps.length < max) return 0;
  // Oldest timestamp in window — waiting until it expires opens a slot
  const oldest = timestamps[0];
  return Math.max(0, oldest + windowMs - Date.now() + 5); // +5ms safety margin
}

function _recordCall(bucket) {
  _rl[bucket].timestamps.push(Date.now());
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Exponential backoff with full jitter: delay = rand(0, min(cap, base * 2^attempt))
function _backoffMs(attempt) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * exp);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCHANGE ADAPTER LAYER
// Each adapter exposes the same interface:
//   getBalances(keys)   → { USD, BTC, ETH, SOL }
//   placeOrder(keys, productId, side, quoteSize, baseSize) → { orderId }
//   getMarketData(keys, productIds[]) → { BTC: {price,bid,ask}, ... }
//
// All adapters use the shared rate-limiter + exponential backoff via rateFetch().
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Exchange provider registry ───────────────────────────────────────────────
const EXCHANGE_PROVIDERS = {
  coinbase: {
    id: "coinbase",
    name: "Coinbase Advanced Trade",
    logo: "🔵",
    color: "#1652f0",
    docsUrl: "https://docs.cdp.coinbase.com/advanced-trade/docs/getting-started",
    credFields: [
      { key: "apiKeyName",  label: "API Key Name",       placeholder: "organizations/xxx/apiKeys/yyy", type: "text",     hint: "From cdp.coinbase.com → API Keys" },
      { key: "privateKey",  label: "EC Private Key (PEM)", placeholder: "-----BEGIN EC PRIVATE KEY-----", type: "pem",  hint: "EC P-256 key, keep secret" },
    ],
    productId: (coin) => `${coin}-USD`,
    rateLimit: { read: 600, write: 500, windowMs: 10_000 },
  },
  binance: {
    id: "binance",
    name: "Binance.US",
    logo: "🟡",
    color: "#f0b90b",
    docsUrl: "https://docs.binance.us",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Binance.US API key",    type: "text",     hint: "From binance.us → API Management" },
      { key: "secretKey", label: "Secret Key", placeholder: "Your Binance.US secret key", type: "password", hint: "Never share this key" },
    ],
    productId: (coin) => `${coin}USDT`,
    rateLimit: { read: 1200, write: 100, windowMs: 60_000 },
  },
  kraken: {
    id: "kraken",
    name: "Kraken",
    logo: "🐙",
    color: "#5741d9",
    docsUrl: "https://docs.kraken.com/rest",
    credFields: [
      { key: "apiKey",      label: "API Key",      placeholder: "Your Kraken API key",      type: "text",     hint: "From kraken.com → Security → API" },
      { key: "privateKey",  label: "Private Key",  placeholder: "Your Kraken private key",  type: "password", hint: "Base64-encoded private key" },
    ],
    productId: (coin) => `${coin === "BTC" ? "XBT" : coin}USD`,
    rateLimit: { read: 15, write: 15, windowMs: 3_000 },
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    logo: "♊",
    color: "#00dcfa",
    docsUrl: "https://docs.gemini.com/rest-api",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Gemini API key",    type: "text",     hint: "From gemini.com → Settings → API" },
      { key: "secretKey", label: "API Secret", placeholder: "Your Gemini API secret", type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}USD`.toLowerCase(),
    rateLimit: { read: 120, write: 60, windowMs: 60_000 },
  },
  alpaca: {
    id: "alpaca",
    name: "Alpaca",
    logo: "🦙",
    color: "#ffcf47",
    docsUrl: "https://docs.alpaca.markets/reference/getallcryptobars",
    credFields: [
      { key: "apiKey",    label: "API Key ID",  placeholder: "Your Alpaca API key ID",  type: "text",     hint: "From alpaca.markets → API Keys" },
      { key: "secretKey", label: "Secret Key",  placeholder: "Your Alpaca secret key",  type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}/USD`,
    rateLimit: { read: 200, write: 200, windowMs: 60_000 },
  },
  public: {
    id: "public",
    name: "Public.com",
    logo: "🟢",
    color: "#3fba71",
    docsUrl: "https://public.com/api",
    credFields: [
      { key: "apiKey",    label: "API Key",    placeholder: "Your Public.com API key",    type: "text",     hint: "From public.com → Settings → API" },
      { key: "secretKey", label: "API Secret", placeholder: "Your Public.com API secret", type: "password", hint: "Keep this private" },
    ],
    productId: (coin) => `${coin}-USD`,
    rateLimit: { read: 100, write: 60, windowMs: 60_000 },
  },
};

// ─── Shared rate-limiter (per-provider buckets, keyed by providerId:bucket) ───
const _rlBuckets = {};
function _getRLBucket(providerId, bucket) {
  const key = `${providerId}:${bucket}`;
  if (!_rlBuckets[key]) _rlBuckets[key] = { timestamps: [] };
  return _rlBuckets[key];
}
function _rlWaitMs(providerId, bucket, limit, windowMs) {
  const b = _getRLBucket(providerId, bucket);
  const cutoff = Date.now() - windowMs;
  b.timestamps = b.timestamps.filter((t) => t > cutoff);
  if (b.timestamps.length < limit) return 0;
  return Math.max(0, b.timestamps[0] + windowMs - Date.now() + 5);
}
function _rlRecord(providerId, bucket) {
  _getRLBucket(providerId, bucket).timestamps.push(Date.now());
}

// ─── Generic rate-limited fetch with exponential backoff ──────────────────────
async function rateFetch(url, options = {}, providerId = "coinbase", bucket = "READ", _attempt = 0) {
  const provider = EXCHANGE_PROVIDERS[providerId];
  const { read, write, windowMs } = provider?.rateLimit || { read: 600, write: 500, windowMs: 10_000 };
  const limit = bucket === "READ" ? read : write;

  const wait = _rlWaitMs(providerId, bucket, limit, windowMs);
  if (wait > 0) { _rl.stats.throttled++; await _sleep(wait); }
  _rlRecord(providerId, bucket);

  let res, data;
  try {
    res = await fetch(url, options);
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
  } catch (networkErr) {
    if (_attempt < MAX_RETRIES) {
      const delay = _backoffMs(_attempt);
      _rl.stats.retries++;
      _rl.stats.lastError = `[${providerId}] Network error, retry ${_attempt + 1}`;
      await _sleep(delay);
      return rateFetch(url, options, providerId, bucket, _attempt + 1);
    }
    throw networkErr;
  }

  if (res.status === 429 && _attempt < MAX_RETRIES) {
    const delay = parseInt(res.headers?.get?.("Retry-After") || "0") * 1000 || _backoffMs(_attempt);
    _rl.stats.retries++;
    _rl.stats.lastError = `[${providerId}] 429 rate limited, retry ${_attempt + 1}`;
    await _sleep(delay);
    return rateFetch(url, options, providerId, bucket, _attempt + 1);
  }
  if (res.status >= 500 && _attempt < MAX_RETRIES) {
    _rl.stats.retries++;
    await _sleep(_backoffMs(_attempt));
    return rateFetch(url, options, providerId, bucket, _attempt + 1);
  }
  if (!res.ok) {
    const msg = (typeof data === "object" ? data?.message || data?.error || data?.msg : data) || `HTTP ${res.status}`;
    _rl.stats.lastError = `[${providerId}] ${msg}`;
    throw new Error(`[${providerId}] ${msg}`);
  }
  _rl.stats.lastError = null;
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Coinbase Advanced Trade adapter ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function importCBKey(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function buildCBJWT(apiKeyName, pem, method, path) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (obj) => btoa(JSON.stringify(obj)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const signing = `${enc({ alg:"ES256", kid:apiKeyName })}.${enc({ iss:"cdp", nbf:now, exp:now+120, sub:apiKeyName, uri:`${method} api.coinbase.com${path}` })}`;
  const key = await importCBKey(pem);
  const sig = await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, key, new TextEncoder().encode(signing));
  return `${signing}.${btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_")}`;
}
async function cbRequest(keys, method, path, body) {
  const jwt = await buildCBJWT(keys.apiKeyName, keys.privateKey, method, path);
  return rateFetch(`${CB_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }, "coinbase", method === "GET" ? "READ" : "WRITE");
}
const coinbaseAdapter = {
  async getBalances(keys) {
    const data = await cbRequest(keys, "GET", "/accounts");
    const balances = { USD: 0 };
    for (const acc of data.accounts || []) {
      const v = parseFloat(acc.available_balance?.value || 0);
      if (acc.currency === "USD") balances.USD = v;
      else if (COINS.includes(acc.currency)) balances[acc.currency] = v;
    }
    try {
      const fills = await cbRequest(keys, "GET", `/orders/historical/fills?product_id=BTC-USD&limit=5`);
      balances._recentFills = fills.fills?.slice(0, 5) || [];
    } catch (_) {}
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const result = await cbRequest(keys, "POST", "/orders", {
      client_order_id: `algo-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      product_id: productId,
      side,
      order_configuration: side === "BUY"
        ? { market_market_ioc: { quote_size: quoteSize.toFixed(2) } }
        : { market_market_ioc: { base_size: baseSize.toFixed(8) } },
    });
    return { orderId: result.order_id, raw: result };
  },
  async getMarketData(keys, productIds) {
    const data = await cbRequest(keys, "GET", `/best_bid_ask?product_ids=${productIds.join("&product_ids=")}`);
    const out = {};
    for (const pb of data.pricebooks || []) {
      const coin = pb.product_id.replace("-USD","");
      out[coin] = { price: parseFloat(pb.asks?.[0]?.price || pb.bids?.[0]?.price), bid: parseFloat(pb.bids?.[0]?.price), ask: parseFloat(pb.asks?.[0]?.price) };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Binance.US adapter ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
async function bnSign(secret, queryString) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(queryString));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const BN_BASE = "https://api.binance.us/api/v3";
const binanceAdapter = {
  async getBalances(keys) {
    const ts = Date.now();
    const qs = `timestamp=${ts}`;
    const sig = await bnSign(keys.secretKey, qs);
    const data = await rateFetch(`${BN_BASE}/account?${qs}&signature=${sig}`, {
      headers: { "X-MBX-APIKEY": keys.apiKey },
    }, "binance", "READ");
    const balances = { USD: 0 };
    for (const b of data.balances || []) {
      const v = parseFloat(b.free);
      if (b.asset === "USDT" || b.asset === "USD") balances.USD = (balances.USD||0) + v;
      else if (COINS.includes(b.asset)) balances[b.asset] = v;
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const ts = Date.now();
    const params = side === "BUY"
      ? `symbol=${productId}&side=${side}&type=MARKET&quoteOrderQty=${quoteSize.toFixed(2)}&timestamp=${ts}`
      : `symbol=${productId}&side=${side}&type=MARKET&quantity=${baseSize.toFixed(6)}&timestamp=${ts}`;
    const sig = await bnSign(keys.secretKey, params);
    const result = await rateFetch(`${BN_BASE}/order?${params}&signature=${sig}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": keys.apiKey },
    }, "binance", "WRITE");
    return { orderId: String(result.orderId), raw: result };
  },
  async getMarketData(_keys, productIds) {
    const out = {};
    await Promise.all(productIds.map(async pid => {
      const data = await rateFetch(`${BN_BASE}/ticker/bookTicker?symbol=${pid}`, {}, "binance", "READ");
      const coin = pid.replace(/USDT?$/,"");
      out[coin] = { price: parseFloat(data.askPrice), bid: parseFloat(data.bidPrice), ask: parseFloat(data.askPrice) };
    }));
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Kraken adapter ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const KK_BASE = "https://api.kraken.com";
async function kkSign(privateKey, path, nonce, postData) {
  const sha256 = async (msg) => { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msg)); return new Uint8Array(h); };
  const msgBytes = new Uint8Array([...new TextEncoder().encode(path), ...(await sha256(nonce + postData))]);
  const keyBytes = Uint8Array.from(atob(privateKey), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name:"HMAC", hash:"SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, msgBytes);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
const krakenAdapter = {
  async getBalances(keys) {
    const nonce = String(Date.now());
    const path = "/0/private/Balance";
    const sig = await kkSign(keys.privateKey, path, nonce, `nonce=${nonce}`);
    const data = await rateFetch(`${KK_BASE}${path}`, {
      method: "POST",
      headers: { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
      body: `nonce=${nonce}`,
    }, "kraken", "READ");
    const r = data.result || {};
    return { USD: parseFloat(r.ZUSD||0), BTC: parseFloat(r.XXBT||0), ETH: parseFloat(r.XETH||0), SOL: parseFloat(r.SOL||0) };
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const nonce = String(Date.now());
    const path = "/0/private/AddOrder";
    const volume = side === "BUY" ? (quoteSize / 1).toFixed(8) : baseSize.toFixed(8); // simplified
    const body = `nonce=${nonce}&ordertype=market&type=${side.toLowerCase()}&volume=${volume}&pair=${productId}`;
    const sig = await kkSign(keys.privateKey, path, nonce, body);
    const data = await rateFetch(`${KK_BASE}${path}`, {
      method: "POST",
      headers: { "API-Key": keys.apiKey, "API-Sign": sig, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, "kraken", "WRITE");
    return { orderId: data.result?.txid?.[0] || "unknown", raw: data };
  },
  async getMarketData(_keys, productIds) {
    const pairs = productIds.join(",");
    const data = await rateFetch(`${KK_BASE}/0/public/Ticker?pair=${pairs}`, {}, "kraken", "READ");
    const out = {};
    for (const [pair, v] of Object.entries(data.result || {})) {
      const coin = pair.replace(/^X?/,"").replace(/ZUSD$/,"").replace(/^XBT$/,"BTC");
      out[coin] = { price: parseFloat(v.c?.[0]), bid: parseFloat(v.b?.[0]), ask: parseFloat(v.a?.[0]) };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Gemini adapter ───────────────────────────────────────════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
const GEM_BASE = "https://api.gemini.com";
async function gemSign(secret, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-384" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const geminiAdapter = {
  async getBalances(keys) {
    const nonce = String(Date.now());
    const endpoint = "/v1/balances";
    const payload = btoa(JSON.stringify({ request: endpoint, nonce }));
    const sig = await gemSign(keys.secretKey, payload);
    const data = await rateFetch(`${GEM_BASE}${endpoint}`, {
      method: "POST",
      headers: { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig },
    }, "gemini", "READ");
    const balances = { USD: 0 };
    for (const b of Array.isArray(data) ? data : []) {
      const v = parseFloat(b.available);
      if (b.currency === "USD") balances.USD = v;
      else if (COINS.includes(b.currency)) balances[b.currency] = v;
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const nonce = String(Date.now());
    const endpoint = "/v1/order/new";
    const amount = side === "BUY" ? (quoteSize / 1).toFixed(8) : baseSize.toFixed(8);
    const body = { request: endpoint, nonce, symbol: productId, amount, price: "0", side: side.toLowerCase(), type: "exchange market", options: ["immediate-or-cancel"] };
    const payload = btoa(JSON.stringify(body));
    const sig = await gemSign(keys.secretKey, payload);
    const data = await rateFetch(`${GEM_BASE}${endpoint}`, {
      method: "POST",
      headers: { "X-GEMINI-APIKEY": keys.apiKey, "X-GEMINI-PAYLOAD": payload, "X-GEMINI-SIGNATURE": sig },
    }, "gemini", "WRITE");
    return { orderId: String(data.order_id || ""), raw: data };
  },
  async getMarketData(_keys, productIds) {
    const out = {};
    await Promise.all(productIds.map(async pid => {
      const data = await rateFetch(`${GEM_BASE}/v1/pubticker/${pid}`, {}, "gemini", "READ");
      const coin = pid.replace(/usd$/i,"").toUpperCase();
      out[coin] = { price: parseFloat(data.last), bid: parseFloat(data.bid), ask: parseFloat(data.ask) };
    }));
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Alpaca adapter ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const ALP_BASE = "https://api.alpaca.markets";
const alpacaAdapter = {
  async getBalances(keys) {
    const data = await rateFetch(`${ALP_BASE}/v2/account`, {
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey },
    }, "alpaca", "READ");
    const positions = await rateFetch(`${ALP_BASE}/v2/positions`, {
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey },
    }, "alpaca", "READ");
    const balances = { USD: parseFloat(data.cash || 0) };
    for (const p of Array.isArray(positions) ? positions : []) {
      const coin = p.symbol.replace(/\/USD$/,"").replace(/USD$/,"");
      if (COINS.includes(coin)) balances[coin] = parseFloat(p.qty);
    }
    return balances;
  },
  async placeOrder(keys, productId, side, quoteSize, baseSize) {
    const body = { symbol: productId, side: side.toLowerCase(), type: "market", time_in_force: "ioc",
      ...(side === "BUY" ? { notional: quoteSize.toFixed(2) } : { qty: baseSize.toFixed(8) }) };
    const data = await rateFetch(`${ALP_BASE}/v2/orders`, {
      method: "POST",
      headers: { "APCA-API-KEY-ID": keys.apiKey, "APCA-API-SECRET-KEY": keys.secretKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, "alpaca", "WRITE");
    return { orderId: data.id || "", raw: data };
  },
  async getMarketData(_keys, productIds) {
    const symbols = productIds.join(",");
    const data = await rateFetch(`https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols=${symbols}`, {
      headers: { "APCA-API-KEY-ID": _keys.apiKey, "APCA-API-SECRET-KEY": _keys.secretKey },
    }, "alpaca", "READ");
    const out = {};
    for (const [sym, q] of Object.entries(data.quotes || {})) {
      const coin = sym.replace(/\/USD$/,"");
      out[coin] = { price: (q.ap + q.bp) / 2, bid: q.bp, ask: q.ap };
    }
    return out;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Public.com adapter (stub — API not public yet, sandbox only) ─────────────
// ═══════════════════════════════════════════════════════════════════════════════
const publicAdapter = {
  async getBalances(_keys) {
    return { USD: 0, _note: "Public.com API is invite-only. Run in sandbox mode." };
  },
  async placeOrder(_keys, productId, side, quoteSize) {
    return { orderId: `pub-sandbox-${Date.now()}`, raw: { note: "Public.com sandbox order", productId, side, quoteSize } };
  },
  async getMarketData(_keys, productIds) {
    // Fall back to public proxy prices
    return {};
  },
};

// ─── Active adapter resolver ──────────────────────────────────────────────────
const ADAPTERS = {
  coinbase: coinbaseAdapter,
  binance: binanceAdapter,
  kraken: krakenAdapter,
  gemini: geminiAdapter,
  alpaca: alpacaAdapter,
  public: publicAdapter,
};
function getAdapter(providerId) {
  return ADAPTERS[providerId] || coinbaseAdapter;
}

// ─── High-level exchange operations (used by trading engine) ──────────────────
async function exchangeGetBalances(creds) {
  return getAdapter(creds.provider).getBalances(creds.keys[creds.provider] || {});
}
async function exchangePlaceOrder(creds, coin, side, quoteSize, baseSize) {
  const provider = EXCHANGE_PROVIDERS[creds.provider];
  const productId = provider.productId(coin);
  return getAdapter(creds.provider).placeOrder(creds.keys[creds.provider] || {}, productId, side, quoteSize, baseSize);
}
async function exchangeGetMarketData(creds, coins) {
  const provider = EXCHANGE_PROVIDERS[creds.provider];
  const productIds = coins.map(c => provider.productId(c));
  return getAdapter(creds.provider).getMarketData(creds.keys[creds.provider] || {}, productIds);
}

// Legacy Coinbase helpers kept for getRateLimitStats compatibility
function cbGetAccounts(creds) { return coinbaseAdapter.getBalances(creds.keys?.coinbase || creds); }

// ─── Helper: snapshot current rate-limit stats (for React display) ────────────
function getRateLimitStats() {
  return {
    readUsed: _windowUsed("READ"),
    readMax: RATE_LIMITS.READ.max,
    writeUsed: _windowUsed("WRITE"),
    writeMax: RATE_LIMITS.WRITE.max,
    readQueued: _rl.stats.readQueued,
    writeQueued: _rl.stats.writeQueued,
    retries: _rl.stats.retries,
    throttled: _rl.stats.throttled,
    lastError: _rl.stats.lastError,
  };
}

// ─── Utility formatters ────────────────────────────────────────────────────────
const fmt = (n, d = 2) => n?.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";
const fmtPct = (n) => (n >= 0 ? "+" : "") + n?.toFixed(2) + "%";

// ─── Sub-components ───────────────────────────────────────────────────────────
function Badge({ action }) {
  const styles = {
    BUY: { background: "#d1fae5", color: "#065f46" },
    SELL: { background: "#fee2e2", color: "#991b1b" },
    HOLD: { background: "#fef3c7", color: "#92400e" },
  };
  return (
    <span style={{ ...styles[action], padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600, letterSpacing: 0.5 }}>
      {action}
    </span>
  );
}

function MiniChart({ data }) {
  if (data.length < 2) return null;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  const w = 100, h = 32, pad = 2;
  const pts = prices.map((p, i) => {
    const x = pad + (i / (prices.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const up = prices[prices.length - 1] >= prices[0];
  const polyline = pts.join(" ");
  const area = `${pad},${h - pad} ${polyline} ${w - pad},${h - pad}`;
  return (
    <svg width={w} height={h}>
      <polygon points={area} fill={up ? "#d1fae5" : "#fee2e2"} opacity={0.5} />
      <polyline points={polyline} fill="none" stroke={up ? "#10b981" : "#ef4444"} strokeWidth={1.5} />
    </svg>
  );
}

// ─── Price Source Status Banner ──────────────────────────────────────────────
function PriceSourceBanner({ status, onRetry }) {
  const { fetching, ok, diags, lastSuccess, lastAttempt } = status;

  if (fetching && ok === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 10, background: "#fef3c7", border: "0.5px solid #f59e0b", fontSize: 11 }}>
        <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
        <span style={{ color: "#92400e" }}>Fetching live prices from Coinbase Exchange…</span>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (ok) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 8, marginBottom: 10, background: "#d1fae5", border: "0.5px solid #10b981", fontSize: 11 }}>
        <span style={{ color: "#065f46", fontSize: 14 }}>✓</span>
        <span style={{ color: "#065f46", fontWeight: 600 }}>Live prices synced from Coinbase Exchange</span>
        {lastSuccess && <span style={{ color: "#065f46", opacity: 0.7 }}>— last sync {lastSuccess}</span>}
        {fetching && <span style={{ marginLeft: 4, color: "#065f46", opacity: 0.6 }}>syncing…</span>}
      </div>
    );
  }

  // Failed state — show full diagnostics per coin
  const errorTypeLabels = {
    no_proxy: "Proxy not configured",
    cors: "CORS blocked — browser prevented the request",
    network: "Network error — proxy unreachable",
    http: "HTTP error — proxy or Coinbase rejected the request",
    parse: "Parse error — unexpected response format",
    empty: "Empty response — price field missing from proxy",
  };

  return (
    <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 10, background: "#fef2f2", border: "0.5px solid #ef4444", fontSize: 11 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#ef4444", fontSize: 15 }}>⚠</span>
          <span style={{ color: "#991b1b", fontWeight: 600 }}>
            Live price sync failed — showing simulated prices
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {lastAttempt && <span style={{ color: "#991b1b", opacity: 0.7 }}>last tried {lastAttempt}</span>}
          <button onClick={onRetry} style={{ padding: "3px 10px", borderRadius: 5, border: "0.5px solid #ef4444", background: "#fee2e2", color: "#991b1b", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            Retry
          </button>
        </div>
      </div>

      {/* Per-coin breakdown */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {COINS.map((coin) => {
          const d = diags[coin];
          if (!d) return null;
          return (
            <div key={coin} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <span style={{ minWidth: 32, fontWeight: 600, color: d.ok ? "#065f46" : "#991b1b" }}>
                {d.ok ? "✓" : "✗"} {coin}
              </span>
              {d.ok ? (
                <span style={{ color: "#065f46" }}>${d.price?.toLocaleString()}</span>
              ) : (
                <span style={{ color: "#7f1d1d" }}>
                  <strong style={{ color: "#ef4444" }}>[{d.errorType?.toUpperCase()}]</strong>{" "}
                  {errorTypeLabels[d.errorType] || d.errorType}
                  {d.errorMsg && d.errorMsg !== errorTypeLabels[d.errorType] && (
                    <span style={{ opacity: 0.7 }}> — {d.errorMsg}</span>
                  )}
                  {d.httpStatus && <span style={{ opacity: 0.6 }}> (HTTP {d.httpStatus})</span>}
                  {d.raw && (
                    <div style={{ marginTop: 2, fontFamily: "monospace", fontSize: 10, opacity: 0.6, wordBreak: "break-all" }}>
                      Raw: {d.raw}
                    </div>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 8, color: "#991b1b", lineHeight: 1.6, fontSize: 11 }}>
        {diags[COINS[0]]?.errorType === "no_proxy" && (
          <div style={{ background: "#fff7ed", border: "0.5px solid #f59e0b", borderRadius: 6, padding: "8px 10px", color: "#92400e" }}>
            <strong>Setup required:</strong> Deploy the included <code>coinbase-cors-proxy</code> to Vercel,
            then set <code style={{ background: "#fef3c7", padding: "1px 4px", borderRadius: 3 }}>PROXY_BASE</code> in
            the source to your Cloud Run function URL.
            See <strong>README.md</strong> inside the proxy folder for step-by-step instructions.
          </div>
        )}
        {diags[COINS[0]]?.errorType === "cors" && (
          <div style={{ opacity: 0.8 }}>
            <strong>CORS blocked:</strong> The proxy URL may be wrong or not yet deployed.
            Verify <code>PROXY_BASE</code> matches your Cloud Run function URL exactly.
          </div>
        )}
        {diags[COINS[0]]?.errorType === "network" && (
          <div style={{ opacity: 0.8 }}>
            <strong>Network error:</strong> Proxy is unreachable — check the Vercel deployment is live and the URL is correct.
          </div>
        )}
        {diags[COINS[0]]?.errorType === "http" && (
          <div style={{ opacity: 0.8 }}>
            <strong>HTTP {diags[COINS[0]]?.httpStatus}:</strong> The proxy responded with an error.
            Check the Vercel function logs for details.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rate Limit Monitor Panel ────────────────────────────────────────────────
function RateLimitMonitor({ stats }) {
  const readPct = Math.min((stats.readUsed / stats.readMax) * 100, 100);
  const writePct = Math.min((stats.writeUsed / stats.writeMax) * 100, 100);
  const readColor = readPct > 80 ? "#ef4444" : readPct > 50 ? "#f59e0b" : "#10b981";
  const writeColor = writePct > 80 ? "#ef4444" : writePct > 50 ? "#f59e0b" : "#10b981";

  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px 14px", marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <i className="ti ti-activity" aria-hidden="true" /> API rate limits — 10-second rolling window
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
        {[
          { label: "Read (GET)", used: stats.readUsed, max: stats.readMax, pct: readPct, color: readColor, queued: stats.readQueued },
          { label: "Write (POST)", used: stats.writeUsed, max: stats.writeMax, pct: writePct, color: writeColor, queued: stats.writeQueued },
        ].map(({ label, used, max, pct, color, queued }) => (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
              <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
              <span style={{ fontWeight: 600, color }}>
                {used} / {max}
                {queued > 0 && <span style={{ marginLeft: 6, color: "#f59e0b" }}>+{queued} queued</span>}
              </span>
            </div>
            <div style={{ height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: pct + "%", height: "100%", background: color, borderRadius: 3, transition: "width 0.3s ease" }} />
            </div>
            <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
              {(100 - pct).toFixed(0)}% headroom · {max - used} slots free
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--color-text-secondary)", borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8, flexWrap: "wrap" }}>
        <span><i className="ti ti-refresh" aria-hidden="true" style={{ color: stats.retries > 0 ? "#f59e0b" : "inherit" }} /> Retries: <strong style={{ color: stats.retries > 0 ? "#f59e0b" : "var(--color-text-primary)" }}>{stats.retries}</strong></span>
        <span><i className="ti ti-clock-pause" aria-hidden="true" style={{ color: stats.throttled > 0 ? "#f59e0b" : "inherit" }} /> Throttled: <strong style={{ color: stats.throttled > 0 ? "#f59e0b" : "var(--color-text-primary)" }}>{stats.throttled}</strong></span>
        <span style={{ fontSize: 10 }}>Backoff: base {BASE_DELAY_MS}ms · max {MAX_BACKOFF_MS / 1000}s · {MAX_RETRIES} retries</span>
        {stats.lastError && (
          <span style={{ marginLeft: "auto", color: "#ef4444", fontSize: 10, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <i className="ti ti-alert-triangle" aria-hidden="true" /> {stats.lastError}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function ExitRuleRow({ coin, rule, onChange, color }) {
  const set = (k, v) => onChange({ ...rule, [k]: v });
  return (
    <div style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px", border: `0.5px solid ${color}44` }}>
      <div style={{ fontWeight: 600, fontSize: 12, color, marginBottom: 8 }}>{coin}/USD</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {/* Take Profit */}
        <div>
          <div style={{ fontSize: 11, color: "#10b981", fontWeight: 600, marginBottom: 5 }}>
            ↑ Take Profit
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <select value={rule.takeProfitType} onChange={e => set("takeProfitType", e.target.value)}
              style={{ fontSize: 11, padding: "3px 4px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <option value="percent">%</option>
              <option value="absolute">$ price</option>
            </select>
            <input type="number" value={rule.takeProfitValue}
              onChange={e => set("takeProfitValue", e.target.value)}
              min="0" step={rule.takeProfitType === "percent" ? "0.1" : "1"}
              placeholder={rule.takeProfitType === "percent" ? "e.g. 2" : "e.g. 500"}
              style={{ width: "100%", fontSize: 11, padding: "3px 6px", boxSizing: "border-box" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            {rule.takeProfitType === "percent"
              ? `Sell when price rises ${rule.takeProfitValue || "0"}% above entry`
              : `Sell when price rises $${rule.takeProfitValue || "0"} above entry`}
          </div>
        </div>
        {/* Stop Loss */}
        <div>
          <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 600, marginBottom: 5 }}>
            ↓ Stop Loss
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <select value={rule.stopLossType} onChange={e => set("stopLossType", e.target.value)}
              style={{ fontSize: 11, padding: "3px 4px", borderRadius: 4, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", cursor: "pointer" }}>
              <option value="percent">%</option>
              <option value="absolute">$ price</option>
            </select>
            <input type="number" value={rule.stopLossValue}
              onChange={e => set("stopLossValue", e.target.value)}
              min="0" step={rule.stopLossType === "percent" ? "0.1" : "1"}
              placeholder={rule.stopLossType === "percent" ? "e.g. 1" : "e.g. 200"}
              style={{ width: "100%", fontSize: 11, padding: "3px 6px", boxSizing: "border-box" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 3 }}>
            {rule.stopLossType === "percent"
              ? `Sell when price drops ${rule.stopLossValue || "0"}% below entry`
              : `Sell when price drops $${rule.stopLossValue || "0"} below entry`}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({ creds, onSave, onClose }) {
  const defaultExitRules = {
    BTC: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    ETH: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    SOL: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
  };
  const defaultKeys = {
    coinbase: { apiKeyName: "", privateKey: "" },
    binance:  { apiKey: "", secretKey: "" },
    kraken:   { apiKey: "", privateKey: "" },
    gemini:   { apiKey: "", secretKey: "" },
    alpaca:   { apiKey: "", secretKey: "" },
    public:   { apiKey: "", secretKey: "" },
  };
  const [form, setForm] = useState({
    provider:      creds.provider || "coinbase",
    tradeSizeUSD:  creds.tradeSizeUSD || "50",
    minConfidence: creds.minConfidence || "60",
    enabledCoins:  creds.enabledCoins || ["BTC"],
    sandbox:       creds.sandbox !== undefined ? creds.sandbox : false,
    keys:          { ...defaultKeys, ...creds.keys },
    exitRules:     creds.exitRules || defaultExitRules,
  });
  const [activeTab, setActiveTab] = useState("provider");
  const [showSecrets, setShowSecrets] = useState({});

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setProviderKey = (providerId, field, value) =>
    set("keys", { ...form.keys, [providerId]: { ...form.keys[providerId], [field]: value } });
  const toggleCoin = (c) => set("enabledCoins",
    form.enabledCoins.includes(c)
      ? form.enabledCoins.filter(x => x !== c)
      : [...form.enabledCoins, c]);
  const setExitRule = (coin, rule) => set("exitRules", { ...form.exitRules, [coin]: rule });
  const toggleSecret = (field) => setShowSecrets(s => ({ ...s, [field]: !s[field] }));

  const activeProviderInfo = EXCHANGE_PROVIDERS[form.provider];
  const activeKeys = form.keys[form.provider] || {};

  const tabStyle = (id) => ({
    padding: "6px 14px", borderRadius: 6, border: "0.5px solid", cursor: "pointer", fontSize: 12, fontWeight: 600,
    borderColor: activeTab === id ? "#6366f1" : "var(--color-border-tertiary)",
    background: activeTab === id ? "#6366f122" : "transparent",
    color: activeTab === id ? "#6366f1" : "var(--color-text-secondary)",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, padding: "24px 28px", width: 560, maxWidth: "96vw", maxHeight: "92vh", overflowY: "auto" }}>
        
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Settings</div>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>Exchange, credentials & trading rules</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "var(--color-text-secondary)" }}>
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
          <button style={tabStyle("provider")} onClick={() => setActiveTab("provider")}>🏦 Exchange</button>
          <button style={tabStyle("credentials")} onClick={() => setActiveTab("credentials")}>🔑 Credentials</button>
          <button style={tabStyle("trading")} onClick={() => setActiveTab("trading")}>📊 Trading Rules</button>
        </div>

        {/* ── Tab: Exchange selector ─────────────────────────────────────── */}
        {activeTab === "provider" && (
          <div>
            <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 12 }}>
              Select your trading platform. Each exchange uses its own authentication and order format.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {Object.values(EXCHANGE_PROVIDERS).map(p => {
                const keys = form.keys[p.id] || {};
                const configured = Object.values(keys).some(v => v && v.trim());
                const active = form.provider === p.id;
                return (
                  <div key={p.id} onClick={() => set("provider", p.id)}
                    style={{ padding: "12px 14px", borderRadius: 10, cursor: "pointer", transition: "all 0.15s",
                      border: `0.5px solid ${active ? p.color : "var(--color-border-tertiary)"}`,
                      background: active ? p.color + "15" : "var(--color-background-secondary)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 18 }}>{p.logo}</span>
                      <span style={{ fontWeight: 600, fontSize: 13, color: active ? p.color : "var(--color-text-primary)" }}>{p.name}</span>
                      {configured && <span style={{ marginLeft: "auto", fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>✓</span>}
                      {active && !configured && <span style={{ marginLeft: "auto", fontSize: 10, background: "#fef3c7", color: "#92400e", padding: "1px 6px", borderRadius: 4 }}>needs keys</span>}
                    </div>
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>
                      {p.id === "public" ? "Invite-only API — sandbox mode only" :
                       `Rate limit: ${p.rateLimit.read} reads / ${p.rateLimit.windowMs/1000}s`}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--color-background-secondary)", border: `0.5px solid ${activeProviderInfo.color}44`, fontSize: 11 }}>
              <span style={{ fontWeight: 600, color: activeProviderInfo.color }}>{activeProviderInfo.logo} {activeProviderInfo.name}</span>
              {" — "}
              <a href={activeProviderInfo.docsUrl} target="_blank" rel="noopener noreferrer"
                style={{ color: activeProviderInfo.color, textDecoration: "underline" }}>API docs ↗</a>
            </div>
          </div>
        )}

        {/* ── Tab: Credentials (shows fields for ALL providers) ──────────── */}
        {activeTab === "credentials" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", padding: "8px 12px", borderRadius: 8 }}>
              Fill in credentials for any exchanges you want to use. Only the active exchange is used for trading.
              Keys are stored in browser memory only — never sent to any server other than the exchange.
            </div>
            {Object.values(EXCHANGE_PROVIDERS).map(p => {
              const keys = form.keys[p.id] || {};
              const isActive = form.provider === p.id;
              return (
                <div key={p.id} style={{ border: `0.5px solid ${isActive ? p.color : "var(--color-border-tertiary)"}`, borderRadius: 10, padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 16 }}>{p.logo}</span>
                    <span style={{ fontWeight: 600, fontSize: 13, color: p.color }}>{p.name}</span>
                    {isActive && <span style={{ fontSize: 10, background: p.color + "22", color: p.color, padding: "1px 8px", borderRadius: 4, fontWeight: 600 }}>ACTIVE</span>}
                    <a href={p.docsUrl} target="_blank" rel="noopener noreferrer"
                      style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-tertiary)", textDecoration: "underline" }}>docs ↗</a>
                  </div>
                  {p.id === "public" ? (
                    <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>Public.com API is invite-only. This exchange runs in sandbox mode only.</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {p.credFields.map(field => (
                        <label key={field.key} style={{ fontSize: 12 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                            <span style={{ color: "var(--color-text-secondary)" }}>{field.label}</span>
                            {(field.type === "password" || field.type === "pem") && (
                              <button onClick={() => toggleSecret(`${p.id}_${field.key}`)}
                                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "var(--color-text-tertiary)" }}>
                                {showSecrets[`${p.id}_${field.key}`] ? "hide" : "show"}
                              </button>
                            )}
                          </div>
                          {field.type === "pem" ? (
                            <textarea value={keys[field.key] || ""} onChange={e => setProviderKey(p.id, field.key, e.target.value)}
                              placeholder={field.placeholder} rows={3}
                              style={{ width: "100%", fontFamily: "monospace", fontSize: 10, boxSizing: "border-box", resize: "vertical",
                                filter: showSecrets[`${p.id}_${field.key}`] ? "none" : "blur(3px)" }} />
                          ) : (
                            <input
                              type={field.type === "password" && !showSecrets[`${p.id}_${field.key}`] ? "password" : "text"}
                              value={keys[field.key] || ""}
                              onChange={e => setProviderKey(p.id, field.key, e.target.value)}
                              placeholder={field.placeholder}
                              style={{ width: "100%", fontFamily: field.type === "text" ? "inherit" : "monospace", fontSize: 11, boxSizing: "border-box" }} />
                          )}
                          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>{field.hint}</div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Global sandbox toggle */}
            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "10px 14px", borderRadius: 8, border: form.sandbox ? "0.5px solid #6366f1" : "0.5px solid var(--color-border-tertiary)", background: form.sandbox ? "#6366f111" : "transparent" }}>
              <input type="checkbox" checked={form.sandbox} onChange={e => set("sandbox", e.target.checked)} />
              <div>
                <div style={{ fontWeight: 600, color: form.sandbox ? "#6366f1" : "var(--color-text-primary)" }}>Sandbox / paper-trading mode</div>
                <div style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}>Simulates all orders — no real trades on any exchange</div>
              </div>
            </label>
          </div>
        )}

        {/* ── Tab: Trading Rules ──────────────────────────────────────────── */}
        {activeTab === "trading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Trade size (USD per order)</div>
                <input type="number" value={form.tradeSizeUSD} onChange={e => set("tradeSizeUSD", e.target.value)}
                  min="1" max="10000" style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
              <label style={{ fontSize: 12 }}>
                <div style={{ color: "var(--color-text-secondary)", marginBottom: 5 }}>Min signal confidence (%)</div>
                <input type="number" value={form.minConfidence} onChange={e => set("minConfidence", e.target.value)}
                  min="50" max="99" style={{ width: "100%", boxSizing: "border-box" }} />
              </label>
            </div>

            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 600 }}>Active trading pairs</div>
              <div style={{ display: "flex", gap: 8 }}>
                {COINS.map(c => (
                  <button key={c} onClick={() => toggleCoin(c)}
                    style={{ padding: "5px 14px", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 12,
                      border: `0.5px solid ${form.enabledCoins.includes(c) ? COIN_COLORS[c] : "var(--color-border-tertiary)"}`,
                      background: form.enabledCoins.includes(c) ? COIN_COLORS[c] + "22" : "transparent",
                      color: form.enabledCoins.includes(c) ? COIN_COLORS[c] : "var(--color-text-secondary)" }}>
                    {c}/USD
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4 }}>
                Buys driven by indicators. Sells triggered by exit rules only.
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, fontWeight: 600 }}>Exit rules (per coin)</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {form.enabledCoins.map(c => (
                  <ExitRuleRow key={c} coin={c} rule={form.exitRules[c] || defaultExitRules[c]}
                    onChange={rule => setExitRule(c, rule)} color={COIN_COLORS[c]} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: "flex", gap: 10, marginTop: 22, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ padding: "7px 18px", borderRadius: 7, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 13, color: "var(--color-text-secondary)" }}>
            Cancel
          </button>
          <button onClick={() => onSave(form)}
            style={{ padding: "7px 22px", borderRadius: 7, border: `0.5px solid ${activeProviderInfo.color}`, background: activeProviderInfo.color + "22", color: activeProviderInfo.color, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
            <i className="ti ti-device-floppy" aria-hidden="true" /> Save
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Main Component ───────────────────────────────────────────────────────────
function CryptoAlgoTrader() {
  const [selectedCoin, setSelectedCoin] = useState("BTC");
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1500);
  const [showSettings, setShowSettings] = useState(false);

  // Coinbase automation state
  const [creds, setCreds] = useState({
    provider: "coinbase",           // active exchange
    tradeSizeUSD: "50",
    minConfidence: "60",
    enabledCoins: ["BTC"],
    sandbox: false,
    keys: {                         // per-provider API credentials
      coinbase: { apiKeyName: "", privateKey: "" },
      binance:  { apiKey: "", secretKey: "" },
      kraken:   { apiKey: "", privateKey: "" },
      gemini:   { apiKey: "", secretKey: "" },
      alpaca:   { apiKey: "", secretKey: "" },
      public:   { apiKey: "", secretKey: "" },
    },
    exitRules: {
      BTC: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
      ETH: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
      SOL: { takeProfitType: "percent", takeProfitValue: "2", stopLossType: "percent", stopLossValue: "1" },
    },
  });
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoStatus, setAutoStatus] = useState("idle");
  const [autoLog, setAutoLog] = useState([]);
  const [cbBalances, setCbBalances] = useState(null);
  const [cbError, setCbError] = useState(null);
  const [rlStats, setRlStats] = useState(getRateLimitStats());
  const [liveData, setLiveData] = useState({});
  const [priceSourceStatus, setPriceSourceStatus] = useState({
    fetching: true, ok: null, diags: {}, lastSuccess: null, lastAttempt: null,
  });

  const stateRef = useRef({
    BTC: { prices: [COIN_BASE.BTC], volumes: [1], history: [], pnl: 0, position: null, trades: 0 },
    ETH: { prices: [COIN_BASE.ETH], volumes: [1], history: [], pnl: 0, position: null, trades: 0 },
    SOL: { prices: [COIN_BASE.SOL], volumes: [1], history: [], pnl: 0, position: null, trades: 0 },
  });
  const [snapshot, setSnapshot] = useState(() => JSON.parse(JSON.stringify(stateRef.current)));
  const [news, setNews] = useState([]);
  const [activeSentiment, setActiveSentiment] = useState(0);
  const [newsStatus, setNewsStatus] = useState("idle"); // idle | loading | ok | error
  const newsIdRef = useRef(0);
  const tickRef = useRef(0);
  const autoLogIdRef = useRef(0);

  const addAutoLog = useCallback((msg, type = "info") => {
    const id = autoLogIdRef.current++;
    const time = new Date().toLocaleTimeString();
    setAutoLog((prev) => [{ id, msg, type, time }, ...prev.slice(0, 49)]);
  }, []);

  // ── Fetch real news from NewsData.io via proxy ───────────────────────────────
  const fetchRealNews = useCallback(async () => {
    if (!PROXY_BASE) return;
    setNewsStatus("loading");
    try {
      // Use direct fetch when top-level (Vite/Netlify), bridge when in Claude iframe
      let payload;
      if (window !== window.parent) {
        // In iframe — use a promise that resolves via postMessage bridge
        payload = await new Promise((resolve, reject) => {
          const handler = (e) => {
            if (e.data?.type !== "CB_NEWS") return;
            window.removeEventListener("message", handler);
            if (e.data.ok) resolve(e.data.payload);
            else reject(new Error(e.data.error));
          };
          window.addEventListener("message", handler);
          setTimeout(() => { window.removeEventListener("message", handler); reject(new Error("News bridge timeout")); }, 10000);
          try {
            const script = window.parent.document.createElement("script");
            script.id = "cbNewsBridge";
            script.textContent = `
              (async () => {
                try {
                  const res = await fetch(${JSON.stringify(NEWS_PROXY_URL)}, { headers: { Accept: "application/json" } });
                  const payload = await res.json();
                  window.frames[0]?.postMessage({ type: "CB_NEWS", ok: true, payload }, "*");
                } catch(e) {
                  window.frames[0]?.postMessage({ type: "CB_NEWS", ok: false, error: e.message }, "*");
                } finally {
                  document.getElementById("cbNewsBridge")?.remove();
                }
              })();
            `;
            window.parent.document.getElementById("cbNewsBridge")?.remove();
            window.parent.document.body.appendChild(script);
          } catch (_) {
            // Cross-origin fallback
            fetch(NEWS_PROXY_URL, { headers: { Accept: "application/json" } })
              .then(r => r.json()).then(resolve).catch(reject);
          }
        });
      } else {
        // Top-level page — direct fetch works fine
        const res = await fetch(NEWS_PROXY_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`Proxy news HTTP ${res.status}`);
        payload = await res.json();
      }
      const articles = payload.articles || [];
      if (articles.length === 0) throw new Error("No articles returned");

      // Build sentiment average from all articles for the signal engine
      const avgSentiment = articles.reduce((sum, a) => sum + (a.sentiment || 0), 0) / articles.length;
      setActiveSentiment(avgSentiment);

      // Format for display
      const formatted = articles.map((a) => ({
        id: newsIdRef.current++,
        text: a.title,
        description: a.description,
        source: a.source,
        url: a.url,
        sentiment: a.sentiment,
        sentimentLabel: a.sentimentLabel,
        time: a.publishedAt
          ? new Date(a.publishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "now",
      }));

      setNews(formatted);
      setNewsStatus("ok");
    } catch (e) {
      setNewsStatus("error");
      console.error("News fetch failed:", e.message);
    }
  }, []);

  // Fetch news on mount and every 5 minutes (NewsData free tier: ~200 req/day)
  useEffect(() => {
    fetchRealNews();
    const id = setInterval(fetchRealNews, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchRealNews]);

  // ── Detect execution context ─────────────────────────────────────────────────
  // inIframe = true  → running inside a sandboxed Claude artifact iframe
  // inIframe = false → running as a top-level page (Vite, Netlify, CodeSandbox top frame)
  const inIframe = window !== window.parent;

  // ── Fetch prices: direct fetch when top-level, bridge when in iframe ──────────
  const fetchViaBridge = useCallback((isAnchor = false) => {
    setPriceSourceStatus((p) => ({ ...p, fetching: true, lastAttempt: new Date().toLocaleTimeString() }));

    if (!inIframe) {
      // Top-level page (Vite / Netlify / published app) — fetch directly, no CSP restriction
      fetchAllPublicPrices().then(({ prices, diags }) => applyPrices(prices, diags, isAnchor));
      return;
    }

    // Inside iframe (Claude artifact) — inject bridge script into parent to bypass CSP
    const productList = COINS.map((c) => PRODUCT_IDS[c]).join(",");
    const url = `${PROXY_BASE}?product=${productList}`;
    try {
      const script = window.parent.document.createElement("script");
      script.id = "cbPriceBridge";
      script.textContent = `
        (async () => {
          try {
            const res = await fetch(${JSON.stringify(url)}, { headers: { Accept: "application/json" } });
            const data = await res.json();
            window.frames[0]?.postMessage({ type: "CB_PRICES", ok: true, data }, "*");
          } catch(e) {
            window.frames[0]?.postMessage({ type: "CB_PRICES", ok: false, error: e.message }, "*");
          } finally {
            document.getElementById("cbPriceBridge")?.remove();
          }
        })();
      `;
      window.parent.document.getElementById("cbPriceBridge")?.remove();
      window.parent.document.body.appendChild(script);
    } catch (_) {
      // Cross-origin parent — fall back to direct fetch
      fetchAllPublicPrices().then(({ prices, diags }) => applyPrices(prices, diags, isAnchor));
    }
  }, [inIframe]);

  const applyPrices = useCallback((prices, diags, isAnchor = false) => {
    const s = stateRef.current;
    const anyOk = Object.keys(prices).length > 0;
    for (const coin of COINS) {
      if (prices[coin]) {
        if (isAnchor && s[coin].prices.length > 1) {
          s[coin].prices[s[coin].prices.length - 1] = prices[coin];
        } else {
          s[coin].prices = [prices[coin]];
          s[coin].volumes = [1];
        }
      }
    }
    if (anyOk) setSnapshot(JSON.parse(JSON.stringify(s)));
    setPriceSourceStatus({
      fetching: false, ok: anyOk, diags,
      lastSuccess: anyOk ? new Date().toLocaleTimeString() : null,
      lastAttempt: new Date().toLocaleTimeString(),
    });
  }, []);

  // ── Listen for postMessage responses from the bridge script ──────────────────
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type !== "CB_PRICES") return;
      if (!event.data.ok) {
        const msg = event.data.error || "Bridge fetch failed";
        const diags = {};
        COINS.forEach(c => { diags[c] = { ok: false, errorType: "network", errorMsg: msg }; });
        setPriceSourceStatus(p => ({ ...p, fetching: false, ok: false, diags,
          lastAttempt: new Date().toLocaleTimeString() }));
        return;
      }
      // Parse the proxy payload
      const payload = event.data.data;
      const prices = {}, diags = {};
      COINS.forEach(coin => {
        const coinData = payload?.data?.[coin];
        const price = parseFloat(coinData?.price);
        if (!coinData || isNaN(price)) {
          diags[coin] = { ok: false, errorType: "empty",
            errorMsg: `${coin} missing from response` };
        } else {
          prices[coin] = price;
          diags[coin] = { ok: true, price,
            bid: parseFloat(coinData.bid)||null, ask: parseFloat(coinData.ask)||null };
        }
      });
      applyPrices(prices, diags, false);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [applyPrices]);

  // ── Bootstrap on mount ────────────────────────────────────────────────────────
  useEffect(() => { fetchViaBridge(false); }, []);

  // ── Re-anchor every 15s ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => { if (!autoEnabled) fetchViaBridge(true); }, 15_000);
    return () => clearInterval(id);
  }, [autoEnabled, fetchViaBridge]);

  // ── Poll rate-limit stats every 500ms ──────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setRlStats(getRateLimitStats()), 500);
    return () => clearInterval(id);
  }, []);

  // ── Fetch live Coinbase prices + orderbook + candles ───────────────────────
  const fetchLiveMarketData = useCallback(async () => {
    const keys = creds.keys?.[creds.provider] || {};
    const hasKeys = Object.values(keys).some(v => v && v.trim());
    if (!hasKeys) return;
    try {
      const marketData = await exchangeGetMarketData(creds, creds.enabledCoins);
      const s = stateRef.current;
      for (const [coin, d] of Object.entries(marketData)) {
        if (!d?.price || isNaN(d.price)) continue;
        s[coin].prices.push(d.price);
        if (s[coin].prices.length > 200) s[coin].prices.shift();
        s[coin].volumes.push(Math.max(0.3, Math.random() * 0.5 + 0.75)); // volume proxy
        if (s[coin].volumes.length > 200) s[coin].volumes.shift();
      }
      setLiveData(prev => ({ ...prev, ...marketData }));
    } catch (e) {
      addAutoLog(`Market data error: ${e.message}`, "error");
    }
  }, [creds, addAutoLog]);

  // ── Fetch Coinbase balances (single /accounts call) ───────────────────────
  const fetchBalances = useCallback(async () => {
    const keys = creds.keys?.[creds.provider] || {};
    const hasKeys = Object.values(keys).some(v => v && v.trim());
    if (!hasKeys) return;
    setCbError(null);
    try {
      const balances = await exchangeGetBalances(creds);
      setCbBalances(balances);
      addAutoLog(`[${EXCHANGE_PROVIDERS[creds.provider]?.name}] Balances — USD $${balances.USD?.toFixed(2)}`, "success");
    } catch (e) {
      setCbError(e.message);
      addAutoLog(`Balance fetch failed: ${e.message}`, "error");
    }
  }, [creds, addAutoLog]);

  // ── Execute a real trade on Coinbase ───────────────────────────────────────
  const executeRealTrade = useCallback(async (coin, action, price, confidence) => {
    // Confidence gate applies to all modes including sandbox (exits are always 100%)
    const minConf = parseFloat(creds.minConfidence) || 60;
    if (action === "BUY" && confidence < minConf) {
      addAutoLog(`Skipped BUY ${coin}: confidence ${confidence.toFixed(1)}% < threshold ${minConf}%`, "warn");
      return { success: false, reason: "low_confidence" };
    }
    if (creds.sandbox) {
      addAutoLog(`[SANDBOX] ${action} ${coin} @ $${price.toFixed(2)} (conf ${confidence.toFixed(1)}%)`, "sandbox");
      return { success: true, sandbox: true };
    }
    try {
      const tradeUSD = parseFloat(creds.tradeSizeUSD);
      const baseSize = tradeUSD / price;
      const result = await exchangePlaceOrder(creds, coin, action, tradeUSD, baseSize);
      const providerName = EXCHANGE_PROVIDERS[creds.provider]?.name || creds.provider;
      addAutoLog(`✓ [${providerName}] ${action} ${coin} — ID: ${result.orderId?.slice(0,12)}... @ $${price.toFixed(2)}`, "success");
      await fetchBalances();
      return { success: true, orderId: result.orderId };
    } catch (e) {
      addAutoLog(`Order failed (${action} ${coin}): ${e.message}`, "error");
      return { success: false, error: e.message };
    }
  }, [creds, addAutoLog, fetchBalances]);

  // ── Start / Stop automation ─────────────────────────────────────────────────
  const startAutomation = useCallback(async () => {
    const keys = creds.keys?.[creds.provider] || {};
    const hasKeys = Object.values(keys).some(v => v && v.trim());
    if (!hasKeys) {
      setCbError(`No ${EXCHANGE_PROVIDERS[creds.provider]?.name} credentials — open Settings → API Credentials`);
      return;
    }
    setAutoStatus("connecting");
    addAutoLog("Connecting to Coinbase Advanced Trade API...", "info");
    try {
      await fetchBalances();
      await fetchLiveMarketData();
      setAutoStatus("live");
      setAutoEnabled(true);
      addAutoLog(`Automation started — pairs: ${creds.enabledCoins.join(", ")} | size: $${creds.tradeSizeUSD} | min conf: ${creds.minConfidence}%${creds.sandbox ? " | SANDBOX" : ""}`, "success");
    } catch (e) {
      setAutoStatus("error");
      setCbError(e.message);
      addAutoLog(`Connection failed: ${e.message}`, "error");
    }
  }, [creds, fetchBalances, fetchLiveMarketData, addAutoLog]);

  const stopAutomation = useCallback(() => {
    setAutoEnabled(false);
    setAutoStatus("idle");
    addAutoLog("Automation stopped by user", "warn");
  }, [addAutoLog]);

  // ── Main simulation tick ────────────────────────────────────────────────────
  const runTick = useCallback(() => {
    const s = stateRef.current;
    tickRef.current += 1;

    // News is fetched on a real interval — nothing to do per tick

    // Fetch live market data every 5 ticks if automation is active
    if (autoEnabled && tickRef.current % 5 === 0) fetchLiveMarketData();

    COINS.forEach((coin) => {
      const cs = s[coin];
      const lastPrice = cs.prices[cs.prices.length - 1];

      // If not using live data for this coin, simulate
      if (!autoEnabled || !creds.enabledCoins.includes(coin)) {
        const vol = coin === "SOL" ? 0.002 : coin === "ETH" ? 0.0016 : 0.0012;
        cs.prices.push(generatePrice(lastPrice, vol));
        if (cs.prices.length > 200) cs.prices.shift();
        const lv = cs.volumes[cs.volumes.length - 1];
        cs.volumes.push(Math.max(0.3, lv + (Math.random() - 0.48) * 0.3));
        if (cs.volumes.length > 200) cs.volumes.shift();
      }

      const newPrice = cs.prices[cs.prices.length - 1];
      const avgVol = cs.volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(cs.volumes.length, 20);
      const volumeRatio = (cs.volumes[cs.volumes.length - 1] || 1) / avgVol;

      const indicators = {
        currentPrice: newPrice,
        sma20: calcSMA(cs.prices, 20),
        sma50: calcSMA(cs.prices, 50),
        rsi: calcRSI(cs.prices, 14),
        boll: calcBollinger(cs.prices, 20),
        macd: calcMACD(cs.prices),
      };

      const signal = generateSignal(indicators, activeSentiment, volumeRatio);

      // ── Compute take-profit and stop-loss levels from exit rules ─────────────
      const exitRule = creds.exitRules?.[coin] || {};
      const entryPrice = cs.position?.price || newPrice;

      const resolveLevel = (type, value, direction) => {
        const v = parseFloat(value) || 0;
        if (!v) return null;
        if (type === "percent") {
          return direction === "up"
            ? entryPrice * (1 + v / 100)
            : entryPrice * (1 - v / 100);
        }
        // absolute price target
        return direction === "up" ? entryPrice + v : entryPrice - v;
      };

      const takeProfitPrice = cs.position
        ? resolveLevel(exitRule.takeProfitType, exitRule.takeProfitValue, "up") : null;
      const stopLossPrice = cs.position
        ? resolveLevel(exitRule.stopLossType, exitRule.stopLossValue, "down") : null;

      // ── Determine exit trigger ────────────────────────────────────────────────
      const hitTakeProfit = takeProfitPrice && newPrice >= takeProfitPrice;
      const hitStopLoss   = stopLossPrice   && newPrice <= stopLossPrice;
      const shouldSell    = cs.position && (hitTakeProfit || hitStopLoss);
      const sellReason    = hitTakeProfit ? "TAKE_PROFIT" : hitStopLoss ? "STOP_LOSS" : null;

      // ── BUY: signal-driven, gated by confidence threshold ───────────────────
      const minConf = parseFloat(creds.minConfidence) || 60;
      const confPassed = parseFloat(signal.confidence) >= minConf;
      if (signal.action === "BUY" && !cs.position && confPassed) {
        cs.position = { price: newPrice, size: 1, entryTick: tickRef.current };
        cs.trades++;
        if (autoEnabled && creds.enabledCoins.includes(coin)) {
          executeRealTrade(coin, "BUY", newPrice, parseFloat(signal.confidence));
        }
      }

      // ── SELL: exit rules only (take profit / stop loss) ───────────────────────
      if (shouldSell) {
        const profit = (newPrice - cs.position.price) / cs.position.price * 100;
        cs.pnl += profit;
        cs.position = null;
        cs.trades++;
        if (autoEnabled && creds.enabledCoins.includes(coin)) {
          executeRealTrade(coin, "SELL", newPrice, 100); // exit rules are always 100% confident
        }
      }

      // Store sell reason in the history entry below
      const exitTrigger = shouldSell ? sellReason : null;

      const unrealized = cs.position ? (newPrice - cs.position.price) / cs.position.price * 100 : 0;
      cs.history.push({
        t: tickRef.current, price: newPrice,
        sma20: indicators.sma20, sma50: indicators.sma50,
        bUpper: indicators.boll?.upper, bLower: indicators.boll?.lower,
        rsi: indicators.rsi, action: signal.action,
        confidence: parseFloat(signal.confidence),
        score: parseFloat(signal.score),
        agreeingCount: signal.agreeingCount,
        totalIndicators: signal.totalIndicators,
        volumeRatio, reasons: signal.reasons,
        pnl: cs.pnl + unrealized,
        exitTrigger,
        takeProfitPrice: cs.position ? takeProfitPrice : null,
        stopLossPrice: cs.position ? stopLossPrice : null,
      });
      if (cs.history.length > 80) cs.history.shift();
    });

    setSnapshot(JSON.parse(JSON.stringify(s)));
  }, [autoEnabled, creds, activeSentiment, fetchLiveMarketData, executeRealTrade]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(runTick, speed);
    return () => clearInterval(id);
  }, [running, speed, runTick]);

  // ── Derived display data ───────────────────────────────────────────────────
  const coin = snapshot[selectedCoin];
  const lastH = coin.history[coin.history.length - 1];
  const currentPrice = coin.prices[coin.prices.length - 1];
  const priceChange = coin.prices.length > 1 ? ((currentPrice - coin.prices[coin.prices.length - 2]) / coin.prices[coin.prices.length - 2]) * 100 : 0;
  const unrealized = coin.position ? ((currentPrice - coin.position.price) / coin.position.price) * 100 : 0;

  const chartData = coin.history.slice(-60).map((h, i) => ({
    i, price: +h.price.toFixed(2),
    sma20: h.sma20 ? +h.sma20.toFixed(2) : null,
    sma50: h.sma50 ? +h.sma50.toFixed(2) : null,
    bUpper: h.bUpper ? +h.bUpper.toFixed(2) : null,
    bLower: h.bLower ? +h.bLower.toFixed(2) : null,
  }));
  const rsiData = coin.history.slice(-60).map((h, i) => ({ i, rsi: h.rsi ? +h.rsi.toFixed(1) : null }));
  const pnlData = coin.history.slice(-60).map((h, i) => ({ i, pnl: +h.pnl.toFixed(3) }));

  const activeProvider = EXCHANGE_PROVIDERS[creds.provider] || EXCHANGE_PROVIDERS.coinbase;
  const activeKeys = creds.keys?.[creds.provider] || {};
  const hasCredentials = Object.values(activeKeys).some(v => v && v.trim());
  const statusColor = { idle: "#94a3b8", connecting: "#f59e0b", live: "#10b981", error: "#ef4444" }[autoStatus];
  const statusLabel = { idle: "Automation idle", connecting: `Connecting to ${activeProvider.name}…`, live: creds.sandbox ? "Sandbox live" : `Live on ${activeProvider.name}`, error: "Connection error" }[autoStatus];
  const logTypeColor = { info: "var(--color-text-secondary)", success: "#10b981", error: "#ef4444", warn: "#f59e0b", sandbox: "#6366f1" };

  const retryPriceFetch = useCallback(() => { fetchViaBridge(false); }, [fetchViaBridge]);

  return (
    <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, color: "var(--color-text-primary)", padding: "12px 0" }}>
      {/* Inject CSS tokens for non-Claude environments (Vite, Netlify, etc.) */}
      <style>{`
        :root {
          --color-background-primary: #0f1117;
          --color-background-secondary: #1a1d27;
          --color-background-info: #1e2433;
          --color-border-primary: #2e3347;
          --color-border-secondary: #2e3347;
          --color-border-tertiary: #252836;
          --color-border-info: #3b4a6b;
          --color-text-primary: #e8eaf0;
          --color-text-secondary: #8b90a7;
          --color-text-tertiary: #555b73;
          --color-text-info: #7eb3f8;
          --font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
        }
        * { box-sizing: border-box; }
        body { background: #0f1117; margin: 0; padding: 16px; }
        input, textarea, select {
          background: #1a1d27;
          border: 0.5px solid #2e3347;
          color: #e8eaf0;
          padding: 6px 8px;
          border-radius: 5px;
          font-size: 12px;
          outline: none;
        }
        input:focus, textarea:focus, select:focus {
          border-color: #6366f1;
        }
        a { color: inherit; }
      `}</style>
      <h2 className="sr-only">Crypto Algo Trading Dashboard with Coinbase Automation</h2>
      {showSettings && <SettingsModal creds={creds} onSave={(f) => { setCreds(f); setShowSettings(false); addAutoLog("Credentials updated", "info"); }} onClose={() => setShowSettings(false)} />}

      {/* ── Top toolbar ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {COINS.map((c) => (
          <button key={c} onClick={() => setSelectedCoin(c)}
            style={{
              padding: "5px 12px", borderRadius: 6, border: "0.5px solid",
              borderColor: selectedCoin === c ? COIN_COLORS[c] : "var(--color-border-tertiary)",
              background: selectedCoin === c ? COIN_COLORS[c] + "22" : "transparent",
              color: selectedCoin === c ? COIN_COLORS[c] : "var(--color-text-secondary)",
              cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 13,
            }}>{c}</button>
        ))}

        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Speed</label>
          <input type="range" min="400" max="3000" step="200" value={speed} onChange={(e) => setSpeed(+e.target.value)} style={{ width: 70 }} />
          <span style={{ fontSize: 11, color: "var(--color-text-secondary)", minWidth: 32 }}>{(speed / 1000).toFixed(1)}s</span>

          <button onClick={() => setRunning((r) => !r)}
            style={{ padding: "5px 14px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: running ? "#fee2e2" : "#d1fae5", color: running ? "#991b1b" : "#065f46", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 12 }}>
            <i className={`ti ${running ? "ti-player-pause" : "ti-player-play"}`} aria-hidden="true" /> {running ? "Pause" : "Start"}
          </button>

          <button onClick={() => setShowSettings(true)}
            style={{ padding: "5px 14px", borderRadius: 6, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontFamily: "inherit", fontSize: 12, color: "var(--color-text-secondary)", display: "flex", alignItems: "center", gap: 5 }}>
            <i className="ti ti-settings" aria-hidden="true" /> Settings
            {hasCredentials && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />}
          </button>
        </div>
      </div>

      {/* ── Coinbase Automation Panel ─────────────────────────────────────────── */}
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: `0.5px solid ${autoEnabled ? statusColor + "88" : "var(--color-border-tertiary)"}`, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, display: "inline-block", boxShadow: autoEnabled ? `0 0 6px ${statusColor}` : "none" }} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>{activeProvider.logo} {activeProvider.name}</span>
            <span style={{ fontSize: 11, color: statusColor, fontWeight: 500 }}>{statusLabel}</span>
          </div>

          {cbError && <span style={{ fontSize: 11, color: "#ef4444", flex: 1 }}><i className="ti ti-alert-circle" aria-hidden="true" /> {cbError}</span>}

          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {cbBalances && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                USD: <strong>${fmt(cbBalances.USD)}</strong>
                {creds.enabledCoins.map((c) => (
                  <span key={c}> · {c}: <strong>{cbBalances[c]?.toFixed(4)}</strong></span>
                ))}
              </span>
            )}
            {hasCredentials && cbBalances && (
              <button onClick={fetchBalances} style={{ padding: "3px 8px", borderRadius: 5, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 11, color: "var(--color-text-secondary)" }}>
                <i className="ti ti-refresh" aria-hidden="true" />
              </button>
            )}
            {!autoEnabled ? (
              <button onClick={startAutomation} disabled={!hasCredentials}
                style={{ padding: "6px 16px", borderRadius: 7, border: "0.5px solid #10b981", background: hasCredentials ? "#d1fae5" : "var(--color-background-secondary)", color: hasCredentials ? "#065f46" : "var(--color-text-secondary)", cursor: hasCredentials ? "pointer" : "not-allowed", fontFamily: "inherit", fontWeight: 600, fontSize: 12, opacity: hasCredentials ? 1 : 0.5 }}>
                <i className="ti ti-robot" aria-hidden="true" /> {hasCredentials ? "Start automation" : "Add credentials first"}
              </button>
            ) : (
              <button onClick={stopAutomation}
                style={{ padding: "6px 16px", borderRadius: 7, border: "0.5px solid #ef4444", background: "#fee2e2", color: "#991b1b", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 12 }}>
                <i className="ti ti-player-stop" aria-hidden="true" /> Stop automation
              </button>
            )}
          </div>
        </div>

        {/* Automation log */}
        {autoLog.length > 0 && (
          <div style={{ marginTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 8, maxHeight: 90, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
            {autoLog.slice(0, 8).map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 8, fontSize: 10, lineHeight: 1.4 }}>
                <span style={{ color: "var(--color-text-tertiary)", minWidth: 60 }}>{l.time}</span>
                <span style={{ color: logTypeColor[l.type] }}>{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Rate Limit Monitor ───────────────────────────────────────────────── */}
      <PriceSourceBanner status={priceSourceStatus} onRetry={retryPriceFetch} />
      <RateLimitMonitor stats={rlStats} />

      {/* ── Ticker row ───────────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
        {COINS.map((c) => {
          const cs = snapshot[c];
          const p = cs.prices[cs.prices.length - 1];
          const chg = cs.prices.length > 1 ? ((p - cs.prices[0]) / cs.prices[0]) * 100 : 0;
          const isLive = autoEnabled && creds.enabledCoins.includes(c);
          return (
            <div key={c} onClick={() => setSelectedCoin(c)}
              style={{
                background: "var(--color-background-secondary)", borderRadius: 8, padding: "10px 12px",
                border: `0.5px solid ${selectedCoin === c ? COIN_COLORS[c] : "var(--color-border-tertiary)"}`,
                cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
              <div>
                <div style={{ fontSize: 11, color: COIN_COLORS[c], fontWeight: 700, marginBottom: 1, display: "flex", alignItems: "center", gap: 5 }}>
                  {c}/USD
                  {isLive && <span style={{ fontSize: 9, background: "#d1fae5", color: "#065f46", padding: "1px 5px", borderRadius: 3, fontWeight: 600 }}>LIVE</span>}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>${fmt(p, c === "BTC" ? 0 : 2)}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: chg >= 0 ? "#10b981" : "#ef4444" }}>{fmtPct(chg)}</div>
              </div>
              <MiniChart data={cs.history.slice(-30).map((h) => ({ price: h.price }))} />
            </div>
          );
        })}
      </div>

      {/* ── Main price chart ─────────────────────────────────────────────────── */}
      <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px 12px", marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: COIN_COLORS[selectedCoin] }}>{selectedCoin}/USD</span>
            <span style={{ fontSize: 20, fontWeight: 700 }}>${fmt(currentPrice, selectedCoin === "BTC" ? 0 : 2)}</span>
            <span style={{ fontWeight: 600, color: priceChange >= 0 ? "#10b981" : "#ef4444" }}>{fmtPct(priceChange)}</span>
          </div>
          <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--color-text-secondary)" }}>
            {[["Price", COIN_COLORS[selectedCoin]], ["SMA20", "#f59e0b"], ["SMA50", "#6366f1"], ["BB", "#94a3b8"]].map(([l, c]) => (
              <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 16, height: 2, background: c, display: "inline-block" }} />{l}
              </span>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="i" hide />
            <YAxis domain={["auto", "auto"]} width={60} tick={{ fontSize: 10 }} tickFormatter={(v) => selectedCoin === "BTC" ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`} />
            <Tooltip formatter={(v) => [`$${fmt(v, 2)}`]} labelFormatter={() => ""} contentStyle={{ fontSize: 11, background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)" }} />
            <Line type="monotone" dataKey="bUpper" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="2 2" />
            <Line type="monotone" dataKey="bLower" stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="2 2" />
            <Line type="monotone" dataKey="sma50" stroke="#6366f1" strokeWidth={1.2} dot={false} strokeDasharray="3 3" />
            <Line type="monotone" dataKey="sma20" stroke="#f59e0b" strokeWidth={1.2} dot={false} strokeDasharray="4 2" />
            <Line type="monotone" dataKey="price" stroke={COIN_COLORS[selectedCoin]} strokeWidth={1.8} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* ── RSI + P&L charts ─────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>RSI (14)</div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={rsiData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="i" hide />
              <YAxis domain={[0, 100]} width={28} tick={{ fontSize: 9 }} ticks={[30, 50, 70]} />
              <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={0.8} />
              <ReferenceLine y={30} stroke="#10b981" strokeDasharray="3 2" strokeWidth={0.8} />
              <Tooltip formatter={(v) => [v?.toFixed(1), "RSI"]} labelFormatter={() => ""} contentStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="rsi" stroke="#a855f7" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          {lastH?.rsi && <div style={{ fontSize: 11, marginTop: 4, color: lastH.rsi > 70 ? "#ef4444" : lastH.rsi < 30 ? "#10b981" : "var(--color-text-secondary)" }}>
            {lastH.rsi.toFixed(1)} — {lastH.rsi > 70 ? "Overbought" : lastH.rsi < 30 ? "Oversold" : "Neutral"}
          </div>}
        </div>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>Cumulative P&L (%)</div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={pnlData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="i" hide />
              <YAxis width={36} tick={{ fontSize: 9 }} tickFormatter={(v) => v.toFixed(1) + "%"} />
              <ReferenceLine y={0} stroke="var(--color-border-secondary)" strokeWidth={0.8} />
              <Tooltip formatter={(v) => [v?.toFixed(3) + "%", "P&L"]} labelFormatter={() => ""} contentStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="pnl" stroke={coin.pnl >= 0 ? "#10b981" : "#ef4444"} strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 11, marginTop: 4, color: (coin.pnl + unrealized) >= 0 ? "#10b981" : "#ef4444" }}>
            Total: {fmtPct(coin.pnl + unrealized)} — {coin.trades} trades
          </div>
        </div>
      </div>

      {/* ── Signal analysis + indicators + position ───────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "14px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 10 }}>Current signal analysis</div>
          {lastH ? (
            <>
              {/* Header row: action badge + confidence + score */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <Badge action={lastH.action} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-secondary)", marginBottom: 3 }}>
                    <span>Indicator agreement</span>
                    <span style={{ fontWeight: 600, color: parseFloat(lastH.confidence) >= parseFloat(creds.minConfidence) ? "#10b981" : "#f59e0b" }}>
                      {lastH.confidence}%
                      {lastH.agreeingCount != null && ` (${lastH.agreeingCount}/${lastH.totalIndicators} agree)`}
                    </span>
                  </div>
                  <div style={{ height: 6, background: "var(--color-border-tertiary)", borderRadius: 3, overflow: "hidden", position: "relative" }}>
                    <div style={{ width: lastH.confidence + "%", height: "100%", borderRadius: 3,
                      background: parseFloat(lastH.confidence) >= parseFloat(creds.minConfidence) ? "#10b981" : "#f59e0b",
                      transition: "width 0.3s ease" }} />
                    {/* Threshold marker */}
                    <div style={{ position: "absolute", top: 0, left: creds.minConfidence + "%", width: 2, height: "100%", background: "#6366f1" }} />
                  </div>
                  <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, display: "flex", justifyContent: "space-between" }}>
                    <span>threshold: {creds.minConfidence}% <span style={{ color: "#6366f1" }}>│</span></span>
                    <span>score: <strong style={{ color: lastH.score > 0 ? "#10b981" : lastH.score < 0 ? "#ef4444" : "var(--color-text-secondary)" }}>{lastH.score > 0 ? "+" : ""}{lastH.score}</strong></span>
                  </div>
                </div>
              </div>

              {/* Buy gate status */}
              {lastH.action === "BUY" && lastH.agreeingCount != null && (
                <div style={{ fontSize: 10, marginBottom: 8, padding: "4px 8px", borderRadius: 5,
                  background: (parseFloat(lastH.confidence) >= parseFloat(creds.minConfidence) && lastH.agreeingCount >= 3) ? "#d1fae5" : "#fef3c7",
                  color: (parseFloat(lastH.confidence) >= parseFloat(creds.minConfidence) && lastH.agreeingCount >= 3) ? "#065f46" : "#92400e" }}>
                  {parseFloat(lastH.confidence) >= parseFloat(creds.minConfidence) && lastH.agreeingCount >= 3
                    ? `✓ BUY gate passed — ${lastH.agreeingCount} indicators agree, confidence above threshold`
                    : `⚠ BUY suppressed — ${parseFloat(lastH.confidence) < parseFloat(creds.minConfidence) ? `confidence ${lastH.confidence}% below ${creds.minConfidence}% threshold` : `only ${lastH.agreeingCount}/3 indicators agree`}`}
                </div>
              )}

              {/* Per-indicator breakdown */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {lastH.reasons.map((r, i) => {
                  const item = typeof r === "object" ? r : { label: r, vote: 0 };
                  const voteColor = item.vote === 1 ? "#10b981" : item.vote === -1 ? "#ef4444" : "#94a3b8";
                  const icon = item.vote === 1 ? "ti-arrow-up" : item.vote === -1 ? "ti-arrow-down" : "ti-minus";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11,
                      padding: "3px 6px", borderRadius: 4,
                      background: item.vote !== 0 ? voteColor + "11" : "transparent" }}>
                      <i className={`ti ${icon}`} aria-hidden="true" style={{ color: voteColor, fontSize: 12, flexShrink: 0 }} />
                      <span style={{ color: "var(--color-text-secondary)", flex: 1 }}>{item.label}</span>
                      {item.vote !== 0 && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: voteColor }}>
                          {item.vote === 1 ? "BULL" : "BEAR"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>Press Start to begin analysis</div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px", flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8 }}>Position</div>
            {coin.position ? (() => {
              const er = creds.exitRules?.[selectedCoin] || {};
              const ep = coin.position.price;
              const resolveLevel = (type, val, dir) => {
                const v = parseFloat(val) || 0;
                if (!v) return null;
                return type === "percent"
                  ? dir === "up" ? ep * (1 + v / 100) : ep * (1 - v / 100)
                  : dir === "up" ? ep + v : ep - v;
              };
              const tp = resolveLevel(er.takeProfitType, er.takeProfitValue, "up");
              const sl = resolveLevel(er.stopLossType, er.stopLossValue, "down");
              return (
                <>
                  <div style={{ fontSize: 11, marginBottom: 3 }}>Entry: <strong>${fmt(ep, 2)}</strong></div>
                  <div style={{ fontSize: 11, marginBottom: 3 }}>Now: <strong>${fmt(currentPrice, 2)}</strong></div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: unrealized >= 0 ? "#10b981" : "#ef4444", marginBottom: 6 }}>
                    Unrealized: {fmtPct(unrealized)}
                  </div>
                  {tp && <div style={{ fontSize: 11, color: "#10b981", display: "flex", justifyContent: "space-between" }}>
                    <span>↑ Take profit</span><strong>${fmt(tp, 2)}</strong>
                  </div>}
                  {sl && <div style={{ fontSize: 11, color: "#ef4444", display: "flex", justifyContent: "space-between" }}>
                    <span>↓ Stop loss</span><strong>${fmt(sl, 2)}</strong>
                  </div>}
                  {autoEnabled && <div style={{ fontSize: 10, marginTop: 4, color: "#6366f1" }}><i className="ti ti-robot" aria-hidden="true" /> Managed by algo</div>}
                </>
              );
            })() : (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>No open position</div>
            )}
          </div>
          <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 6 }}>Indicators</div>
            {lastH && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                <div>SMA20: <strong>${fmt(calcSMA(coin.prices, 20), 0)}</strong></div>
                <div>SMA50: <strong>${fmt(calcSMA(coin.prices, 50), 0)}</strong></div>
                <div>MACD: <strong style={{ color: (calcMACD(coin.prices) || 0) > 0 ? "#10b981" : "#ef4444" }}>{fmt(calcMACD(coin.prices), 2)}</strong></div>
                <div>Vol ratio: <strong>{lastH.volumeRatio?.toFixed(2)}x</strong></div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── News + Signal log ────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span><i className="ti ti-news" aria-hidden="true" /> Live crypto news</span>
            <span style={{ fontSize: 10, display: "flex", alignItems: "center", gap: 5 }}>
              {newsStatus === "loading" && <span style={{ color: "#f59e0b" }}>fetching…</span>}
              {newsStatus === "error" && <span style={{ color: "#ef4444" }}>fetch failed</span>}
              {newsStatus === "ok" && <span style={{ color: "#10b981" }}>● live · NewsData.io</span>}
              <button onClick={fetchRealNews} title="Refresh news"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: 13, padding: "0 2px" }}>
                <i className="ti ti-refresh" aria-hidden="true" />
              </button>
            </span>
          </div>
          {newsStatus === "loading" && news.length === 0 && (
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", padding: "8px 0" }}>Loading real news…</div>
          )}
          {newsStatus === "error" && news.length === 0 && (
            <div style={{ fontSize: 11, color: "#ef4444", padding: "8px 0" }}>
              Could not load news. Check proxy /news route is deployed.
            </div>
          )}
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0 }}>
            {news.map((n) => {
              const sentColor = n.sentiment > 0.1 ? "#10b981" : n.sentiment < -0.1 ? "#ef4444" : "#f59e0b";
              const icon = n.sentiment > 0.1 ? "ti-trending-up" : n.sentiment < -0.1 ? "ti-trending-down" : "ti-minus";
              return (
                <div key={n.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", paddingBottom: 8, marginBottom: 8, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <i className={`ti ${icon}`} style={{ color: sentColor, fontSize: 14, marginTop: 2, flexShrink: 0 }} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 11, color: "var(--color-text-primary)", textDecoration: "none", display: "block", lineHeight: 1.4 }}
                        onMouseOver={e => e.target.style.textDecoration = "underline"}
                        onMouseOut={e => e.target.style.textDecoration = "none"}>
                        {n.text}
                      </a>
                    ) : (
                      <div style={{ fontSize: 11, lineHeight: 1.4 }}>{n.text}</div>
                    )}
                    <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, display: "flex", gap: 8 }}>
                      <span>{n.source}</span>
                      <span>{n.time}</span>
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 600, color: sentColor, flexShrink: 0 }}>
                    {n.sentiment >= 0 ? "+" : ""}{(n.sentiment * 100).toFixed(0)}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ background: "var(--color-background-secondary)", borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)", padding: "12px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginBottom: 8 }}><i className="ti ti-history" aria-hidden="true" /> Signal log</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 200, overflowY: "auto" }}>
            {coin.history.slice(-12).reverse().map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "4px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                <Badge action={h.action} />
                {h.exitTrigger === "TAKE_PROFIT" && (
                  <span style={{ fontSize: 10, background: "#d1fae5", color: "#065f46", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>TP ↑</span>
                )}
                {h.exitTrigger === "STOP_LOSS" && (
                  <span style={{ fontSize: 10, background: "#fee2e2", color: "#991b1b", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>SL ↓</span>
                )}
                <span style={{ color: "var(--color-text-secondary)" }}>${fmt(h.price, selectedCoin === "BTC" ? 0 : 2)}</span>
                <span style={{ marginLeft: "auto", color: "var(--color-text-tertiary)", fontSize: 10 }}>
                  {h.exitTrigger ? h.exitTrigger.replace("_", " ") : `conf ${h.confidence}%`}
                </span>
              </div>
            ))}
            {coin.history.length === 0 && <div style={{ color: "var(--color-text-tertiary)", fontSize: 11 }}>No signals yet — press Start</div>}
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12, padding: "8px 12px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", display: "flex", gap: 14, fontSize: 11, color: "var(--color-text-secondary)", flexWrap: "wrap", alignItems: "center" }}>
        <span><i className="ti ti-clock" aria-hidden="true" /> Tick {tickRef.current}</span>
        <span style={{ color: running ? "#10b981" : "#ef4444" }}><i className={`ti ${running ? "ti-circle-check" : "ti-circle-x"}`} aria-hidden="true" /> {running ? "Algo running" : "Paused"}</span>
        <span style={{ color: statusColor }}><i className="ti ti-robot" aria-hidden="true" /> {statusLabel}</span>
        {creds.sandbox && autoEnabled && <span style={{ color: "#6366f1", fontWeight: 600 }}>SANDBOX MODE — no real orders</span>}
        <span style={{ marginLeft: "auto", color: (coin.pnl + unrealized) >= 0 ? "#10b981" : "#ef4444" }}>
          P&L: {fmtPct(coin.pnl + unrealized)} ({coin.trades} trades)
        </span>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <CryptoAlgoTrader />
    </ErrorBoundary>
  );
}

