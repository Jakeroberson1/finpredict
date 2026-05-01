require('dotenv').config();
const fetch = require('node-fetch');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FMP_BASE = process.env.FMP_BASE_URL;
const FMP_KEY = process.env.FMP_API_KEY;

async function finnhubGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY }).toString();
  const res = await fetch(`${FINNHUB_BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${endpoint}`);
  return res.json();
}

async function fmpGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, apikey: FMP_KEY }).toString();
  const res = await fetch(`${FMP_BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${endpoint}`);
  return res.json();
}

// Used for ticker verification when adding new stocks
async function getProfile(ticker) {
  try {
    const p = await finnhubGet('stock/profile2', { symbol: ticker });
    if (p && p.ticker) {
      return {
        symbol: p.ticker,
        companyName: p.name || ticker,
        price: null,
        marketCap: (p.marketCapitalization || 0) * 1e6,
        sector: p.finnhubIndustry || 'Unknown',
        description: '',
      };
    }
  } catch (_) {}

  // Fallback to FMP profile (works for verification at least)
  try {
    const data = await fmpGet('profile', { symbol: ticker });
    const p = Array.isArray(data) ? data[0] : data;
    if (p && p.symbol) return p;
  } catch (_) {}

  throw new Error(`Ticker ${ticker} not found`);
}

// Fetch all financial metrics for scoring
async function fetchAllMetrics(ticker) {
  const oneYearAgo = Math.floor(Date.now() / 1000) - 365 * 24 * 3600;
  const now = Math.floor(Date.now() / 1000);

  const [quoteRes, profileRes, metricsRes, candlesRes] = await Promise.allSettled([
    finnhubGet('quote', { symbol: ticker }),
    finnhubGet('stock/profile2', { symbol: ticker }),
    finnhubGet('stock/metric', { symbol: ticker, metric: 'all' }),
    finnhubGet('stock/candle', { symbol: ticker, resolution: 'D', from: oneYearAgo, to: now }),
  ]);

  const quote   = quoteRes.status   === 'fulfilled' ? quoteRes.value   : {};
  const profile = profileRes.status === 'fulfilled' ? profileRes.value : {};
  const metrics = metricsRes.status === 'fulfilled' ? (metricsRes.value?.metric || {}) : {};
  const candles = candlesRes.status === 'fulfilled' ? candlesRes.value  : {};

  return { quote, profile, metrics, candles };
}

// ── Extraction helpers ────────────────────────────────────────────────────────

function extractPrice(raw) {
  return raw.quote?.c ?? null;
}

function extractMarketCap(raw) {
  const mc = (raw.profile?.marketCapitalization || 0) * 1e6;
  return mc || null;
}

function extractSharesOutstanding(raw) {
  const s = (raw.profile?.shareOutstanding || 0) * 1e6;
  return s || null;
}

function extractRevenue(raw) {
  // Finnhub returns revenuePerShare in dollars; multiply by shares for total revenue
  const rps = raw.metrics?.revenuePerShareTTM ?? raw.metrics?.revenuePerShareAnnual;
  const shares = extractSharesOutstanding(raw);
  if (rps && shares) return rps * shares;
  return null;
}

function extractPrevRevenue(raw) {
  // Not directly available from Finnhub basic metrics; derive from growth rate
  const rev = extractRevenue(raw);
  const growth = extractRevenueGrowth(raw);
  if (rev && growth != null && growth !== -1) return rev / (1 + growth);
  return null;
}

function extractRevenueGrowth(raw) {
  // Finnhub returns as percentage (e.g. 33.6 = 33.6%), convert to decimal
  const g = raw.metrics?.revenueGrowthTTMYoy ?? raw.metrics?.revenueGrowth3Y;
  if (g != null) return g / 100;
  return null;
}

function extractGrossMargin(raw) {
  // Finnhub returns gross margin as percentage (e.g. 74.5), convert to decimal
  const gm = raw.metrics?.grossMarginTTM ?? raw.metrics?.grossMarginAnnual;
  if (gm != null) return gm / 100;
  return null;
}

function extractGrossMarginPrev(raw) {
  // Not available from Finnhub basic tier; return null
  return null;
}

function extractFCF(raw) {
  return raw.metrics?.freeCashFlowAnnual ?? null;
}

function extractOperatingCashFlow(raw) {
  return null;
}

function extractFCFPerShare(raw) {
  const fcfps = raw.metrics?.freeCashFlowPerShareTTM ?? raw.metrics?.freeCashFlowPerShareAnnual;
  return fcfps ?? null;
}

function extractFCFPerSharePrev(raw) {
  return null;
}

function extractCash(raw) {
  // Finnhub doesn't expose raw cash in basic metrics; use market cap as proxy check
  // Try cashPerShareTTM × shares
  const cps = raw.metrics?.cashPerShareAnnual;
  const shares = extractSharesOutstanding(raw);
  if (cps && shares) return cps * shares;
  return null;
}

function extractTotalDebt(raw) {
  return raw.metrics?.totalDebtAnnual ?? null;
}

function extractPSRatio(raw) {
  return raw.metrics?.psTTM ?? raw.metrics?.psAnnual ?? null;
}

function extractPEFromQuote(raw) {
  return raw.metrics?.peBasicExclExtraTTM ?? null;
}

// Price history from Finnhub candles
function extractPriceHistory(raw) {
  const c = raw.candles;
  if (!c || c.s !== 'ok' || !c.t) return [];
  return c.t.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    price: c.c[i],
  }));
}

module.exports = {
  fetchAllMetrics,
  getProfile,
  extractPrice,
  extractMarketCap,
  extractRevenue,
  extractPrevRevenue,
  extractRevenueGrowth,
  extractGrossMargin,
  extractGrossMarginPrev,
  extractFCF,
  extractOperatingCashFlow,
  extractFCFPerShare,
  extractFCFPerSharePrev,
  extractCash,
  extractTotalDebt,
  extractSharesOutstanding,
  extractPSRatio,
  extractPEFromQuote,
  extractPriceHistory,
};
