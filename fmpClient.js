require('dotenv').config();
const fetch = require('node-fetch');
const { default: YF } = require('yahoo-finance2');

const yf = new YF({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const FMP_BASE = process.env.FMP_BASE_URL;
const FMP_KEY = process.env.FMP_API_KEY;

// FMP is used only for profile verification (checking if a ticker exists)
async function fmpGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ ...params, apikey: FMP_KEY }).toString();
  const url = `${FMP_BASE}/${endpoint}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${endpoint}`);
  return res.json();
}

async function getProfile(ticker) {
  // Try FMP first for profile verification; fall back to Yahoo Finance
  try {
    const data = await fmpGet('profile', { symbol: ticker });
    const p = Array.isArray(data) ? data[0] : data;
    if (p && p.symbol) return p;
  } catch (_) {}

  // Fallback: Yahoo Finance quote
  const q = await yf.quote(ticker);
  if (!q || !q.symbol) throw new Error(`Ticker ${ticker} not found`);
  return {
    symbol: q.symbol,
    companyName: q.longName || q.shortName || ticker,
    price: q.regularMarketPrice,
    marketCap: q.marketCap,
    sector: q.sector || 'Unknown',
    description: '',
  };
}

// Fetch all financial metrics for scoring via Yahoo Finance
async function fetchAllMetrics(ticker) {
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const [summaryRes, quoteRes, histRes, timeSeriesRes, cashFlowRes] = await Promise.allSettled([
    yf.quoteSummary(ticker, { modules: ['financialData', 'defaultKeyStatistics', 'summaryDetail'] }),
    yf.quote(ticker),
    yf.chart(ticker, { period1: oneYearAgo, interval: '1d' }).then(r => r.quotes || []),
    yf.fundamentalsTimeSeries(ticker, { type: 'annual', module: 'financials', period1: twoYearsAgo, period2: new Date() }),
    yf.fundamentalsTimeSeries(ticker, { type: 'annual', module: 'cash-flow', period1: twoYearsAgo, period2: new Date() }),
  ]);

  const summary = summaryRes.status === 'fulfilled' ? summaryRes.value : {};
  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : {};
  const priceHistory = histRes.status === 'fulfilled' ? histRes.value : [];
  // fundamentalsTimeSeries returns array sorted oldest→newest; reverse for [latest, prev]
  const timeSeries = timeSeriesRes.status === 'fulfilled' ? [...timeSeriesRes.value].reverse() : [];
  const cashFlow = cashFlowRes.status === 'fulfilled' ? [...cashFlowRes.value].reverse() : [];

  const fd = summary.financialData || {};
  const ks = summary.defaultKeyStatistics || {};
  const sd = summary.summaryDetail || {};

  return { fd, ks, quote, priceHistory, timeSeries, cashFlow, sd };
}

// ── Extraction helpers (called by scorer.js) ──────────────────────────────────

function extractPrice(raw) {
  return raw.quote?.regularMarketPrice ?? raw.fd?.currentPrice ?? null;
}

function extractMarketCap(raw) {
  return raw.quote?.marketCap ?? null;
}

function extractRevenue(raw) {
  return raw.fd?.totalRevenue ?? null;
}

function extractPrevRevenue(raw) {
  const ts = raw.timeSeries;
  if (ts && ts.length >= 2) return ts[1]?.totalRevenue ?? null;
  return null;
}

function extractRevenueGrowth(raw) {
  // Yahoo provides revenueGrowth as a decimal (YoY TTM)
  if (raw.fd?.revenueGrowth != null) return raw.fd.revenueGrowth;
  // Fallback: calculate from time series
  const ts = raw.timeSeries;
  if (ts && ts.length >= 2) {
    const curr = ts[0]?.totalRevenue;
    const prev = ts[1]?.totalRevenue;
    if (curr && prev && prev !== 0) return (curr - prev) / prev;
  }
  return null;
}

function extractGrossMargin(raw) {
  if (raw.fd?.grossMargins != null) return raw.fd.grossMargins;
  // Derive from time series
  const ts = raw.timeSeries;
  if (ts && ts[0]) {
    const gp = ts[0].grossProfit;
    const rev = ts[0].totalRevenue ?? ts[0].operatingRevenue;
    if (gp != null && rev && rev !== 0) return gp / rev;
  }
  return null;
}

function extractGrossMarginPrev(raw) {
  const ts = raw.timeSeries;
  if (ts && ts.length >= 2) {
    const prev = ts[1];
    const gp = prev?.grossProfit;
    const rev = prev?.totalRevenue ?? prev?.operatingRevenue;
    if (gp != null && rev && rev !== 0) return gp / rev;
  }
  return null;
}

function extractFCF(raw) {
  if (raw.fd?.freeCashflow != null) return raw.fd.freeCashflow;
  // Derive from cash flow time series
  const cf = raw.cashFlow?.[0];
  if (cf) {
    const opCf = cf.operatingCashFlow ?? cf.cashFlowFromContinuingOperatingActivities;
    const capex = cf.capitalExpenditure ?? cf.purchaseOfPPE ?? 0;
    if (opCf != null) return opCf - Math.abs(capex);
  }
  return null;
}

function extractOperatingCashFlow(raw) {
  return raw.fd?.operatingCashflow ?? raw.cashFlow?.[0]?.operatingCashFlow ?? null;
}

function extractFCFPerShare(raw) {
  const fcf = extractFCF(raw);
  if (fcf == null) return null;
  const shares = raw.ks?.sharesOutstanding ?? raw.quote?.sharesOutstanding ?? null;
  if (!shares || shares === 0) return null;
  return fcf / shares;
}

function extractFCFPerSharePrev(raw) {
  const cf = raw.cashFlow;
  if (!cf || cf.length < 2) return null;
  const prev = cf[1];
  const opCf = prev.operatingCashFlow ?? prev.cashFlowFromContinuingOperatingActivities;
  const capex = prev.capitalExpenditure ?? prev.purchaseOfPPE ?? 0;
  if (opCf == null) return null;
  const fcf = opCf - Math.abs(capex);
  const shares = raw.ks?.sharesOutstanding ?? raw.quote?.sharesOutstanding ?? null;
  if (!shares || shares === 0) return null;
  return fcf / shares;
}

function extractCash(raw) {
  if (raw.fd?.totalCash != null) return raw.fd.totalCash;
  const cf = raw.cashFlow?.[0];
  return cf?.cashAndCashEquivalents ?? cf?.cashCashEquivalentsAndShortTermInvestments ?? null;
}

function extractTotalDebt(raw) {
  return raw.fd?.totalDebt ?? null;
}

function extractSharesOutstanding(raw) {
  return raw.ks?.sharesOutstanding ?? raw.quote?.sharesOutstanding ?? null;
}

function extractPSRatio(raw) {
  const mktCap = extractMarketCap(raw);
  const rev = extractRevenue(raw);
  if (!mktCap || !rev || rev === 0) return null;
  return mktCap / rev;
}

function extractPEFromQuote(raw) {
  return raw.quote?.trailingPE ?? null;
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
};
