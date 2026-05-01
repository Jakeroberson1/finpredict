require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./db');
const { scoreTicker, scoreAll } = require('./scorer');
const fmp = require('./fmpClient');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ── Companies ─────────────────────────────────────────────────────────────────

app.get('/api/companies', (req, res) => {
  const companies = db.getCompanies('candidate');
  const result = companies.map(c => {
    const score = db.getLatestScore(c.ticker);
    const metrics = db.getLatestMetrics(c.ticker);
    const latest = metrics[0] || {};
    const prev = metrics[1] || {};
    const priceChange = latest.price && prev.price
      ? ((latest.price - prev.price) / prev.price) * 100
      : null;
    return {
      ...c,
      current_score: score?.total_score ?? c.seed_score,
      tier: score?.tier ?? c.seed_tier,
      price: latest.price ?? null,
      market_cap: latest.market_cap ?? null,
      price_change_pct: priceChange,
      last_updated: score?.date ?? null,
      criteria: score ? {
        c1: score.c1_tam_large, c2: score.c2_revenue_growth, c3: score.c3_gross_margin,
        c4: score.c4_recurring_revenue, c5: score.c5_network_effects, c6: score.c6_founder_led,
        c7: score.c7_nrr_120, c8: score.c8_fcf_positive, c9: score.c9_margin_expanding,
        c10: score.c10_category_creator, c11: score.c11_low_valuation, c12: score.c12_strong_balance,
        c13: score.c13_insider_ownership, c14: score.c14_fcf_per_share, c15: score.c15_no_concentration,
      } : null,
    };
  }).sort((a, b) => (b.current_score || 0) - (a.current_score || 0));
  res.json(result);
});

app.get('/api/historical', (req, res) => {
  const companies = db.getCompanies('historical');
  const result = companies.map(c => {
    const metrics = db.getLatestMetrics(c.ticker);
    const latest = metrics[0] || {};
    return { ...c, price: latest.price ?? null, market_cap: latest.market_cap ?? null };
  }).sort((a, b) => {
    const p = r => parseFloat((r || '0').replace(/[%,]/g, ''));
    return p(b.peak_return) - p(a.peak_return);
  });
  res.json(result);
});

app.get('/api/companies/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const company = db.getCompany(ticker);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json({
    company,
    score: db.getLatestScore(ticker),
    scoreHistory: db.getScoreHistory(ticker, 180),
    priceHistory: db.getPriceHistory(ticker, 365),
    qualitative: db.getLatestQualitative(ticker),
    metrics: db.getLatestMetrics(ticker)[0] || null,
  });
});

// ── Add any public stock ──────────────────────────────────────────────────────

app.post('/api/companies', async (req, res) => {
  const ticker = (req.body.ticker || '').toUpperCase().trim();
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  // Check if already tracked
  const existing = db.getCompany(ticker);
  if (existing) return res.json({ added: false, company: existing, message: 'Already tracked' });

  // Fetch profile from FMP to verify it exists
  try {
    const profile = await fmp.getProfile(ticker);
    if (!profile || !profile.symbol) {
      return res.status(404).json({ error: `Ticker ${ticker} not found on FMP` });
    }
    // Insert as candidate
    db.upsertCompany({
      ticker: profile.symbol,
      name: profile.companyName || ticker,
      category: 'candidate',
      sector: profile.sector || 'Unknown',
      seed_tier: null,
      seed_score: null,
      synopsis: `${profile.companyName} was added manually for analysis. ${profile.description ? profile.description.slice(0, 200) + '...' : ''}`,
    });

    // Score it in background
    res.json({ added: true, ticker: profile.symbol, name: profile.companyName });
    scoreTicker(profile.symbol, false).catch(e => console.error('Background score failed:', e.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refresh ───────────────────────────────────────────────────────────────────

app.post('/api/refresh/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const useGemma = req.query.gemma === 'true';
  try {
    const result = await scoreTicker(ticker, useGemma);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/refresh-all', async (req, res) => {
  const useGemma = req.query.gemma === 'true';
  res.json({ success: true, message: `Refresh started (Gemma: ${useGemma})` });
  scoreAll(useGemma).catch(err => console.error('Background refresh failed:', err.message));
});

app.get('/api/log', (req, res) => res.json(db.getRefreshLog(50)));

// ── Growth Projector ──────────────────────────────────────────────────────────

app.get('/api/project/:ticker', (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const years = Math.min(Math.max(parseInt(req.query.years) || 5, 1), 15);

  const company = db.getCompany(ticker);
  const metrics = db.getLatestMetrics(ticker)[0];
  if (!company || !metrics) return res.status(404).json({ error: 'No data for ticker' });

  const price = metrics.price;
  const revenue = metrics.revenue_ttm;
  const psRatio = metrics.ps_ratio ?? (metrics.market_cap && revenue ? metrics.market_cap / revenue : null);
  const growthRate = metrics.revenue_growth_yoy ?? 0.15;
  // Derive shares from market cap / price if not stored directly
  const shares = metrics.shares_outstanding
    ?? (metrics.market_cap && price ? metrics.market_cap / price : null);

  if (!price || !revenue || !shares) {
    return res.status(422).json({ error: 'Insufficient financial data for projection — try refreshing this ticker first' });
  }

  // Project year-by-year
  const dataPoints = { bear: [], base: [], bull: [], labels: [] };
  let revBear = revenue, revBase = revenue, revBull = revenue;

  dataPoints.bear.push(price);
  dataPoints.base.push(price);
  dataPoints.bull.push(price);
  dataPoints.labels.push('Today');

  for (let y = 1; y <= years; y++) {
    // Growth decelerates by 12% per year (bear), 8% (base), 5% (bull)
    const rBear = Math.max(growthRate * Math.pow(0.88, y - 1), 0.02);
    const rBase = Math.max(growthRate * Math.pow(0.92, y - 1), 0.04);
    const rBull = Math.max(growthRate * Math.pow(0.95, y - 1), 0.06);

    revBear *= (1 + rBear);
    revBase *= (1 + rBase);
    revBull *= (1 + rBull);

    // P/S compression over time
    const psBear = (psRatio || 15) * Math.pow(0.85, y);
    const psBase = (psRatio || 15) * Math.pow(0.92, y);
    const psBull = (psRatio || 15) * Math.pow(0.97, y);

    dataPoints.bear.push(+(revBear * psBear / shares).toFixed(2));
    dataPoints.base.push(+(revBase * psBase / shares).toFixed(2));
    dataPoints.bull.push(+(revBull * psBull / shares).toFixed(2));
    dataPoints.labels.push(`Year ${y}`);
  }

  const bullReturn = ((dataPoints.bull[years] - price) / price * 100).toFixed(1);
  const baseReturn = ((dataPoints.base[years] - price) / price * 100).toFixed(1);
  const bearReturn = ((dataPoints.bear[years] - price) / price * 100).toFixed(1);

  res.json({
    ticker, company: company.name, currentPrice: price, years,
    revenueGrowthRate: growthRate,
    psRatio: psRatio || 15,
    projection: dataPoints,
    summary: { bull: bullReturn, base: baseReturn, bear: bearReturn },
    assumptions: {
      bear: `Growth decelerates 12%/yr, P/S compresses 15%/yr`,
      base: `Growth decelerates 8%/yr, P/S compresses 8%/yr`,
      bull: `Growth decelerates 5%/yr, P/S compresses 3%/yr`,
    },
  });
});

// ── Portfolio ─────────────────────────────────────────────────────────────────

app.get('/api/portfolio', (req, res) => {
  const portfolios = db.getPortfolios();
  if (!portfolios.length) db.getOrCreateDefaultPortfolio();
  res.json(db.getPortfolios());
});

app.post('/api/portfolio', (req, res) => {
  const { name = 'My Portfolio', starting_cash = 10000 } = req.body;
  const p = db.createPortfolio(name, starting_cash);
  res.json(p);
});

app.get('/api/portfolio/:id/positions', (req, res) => {
  const id = parseInt(req.params.id);
  const positions = db.getPortfolioPositions(id);
  const portfolio = db.getPortfolios().find(p => p.id === id);
  if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

  const totalCost = positions.reduce((s, p) => s + p.shares * p.avg_cost_per_share, 0);
  const totalValue = positions.reduce((s, p) => s + p.shares * (p.current_price || p.avg_cost_per_share), 0);
  const cash = portfolio.starting_cash - totalCost;

  res.json({
    portfolio,
    positions: positions.map(p => ({
      ...p,
      cost_basis: +(p.shares * p.avg_cost_per_share).toFixed(2),
      current_value: +(p.shares * (p.current_price || p.avg_cost_per_share)).toFixed(2),
      pnl: +((p.shares * (p.current_price || p.avg_cost_per_share)) - (p.shares * p.avg_cost_per_share)).toFixed(2),
      pnl_pct: p.current_price
        ? +(((p.current_price - p.avg_cost_per_share) / p.avg_cost_per_share) * 100).toFixed(2)
        : 0,
    })),
    summary: {
      total_cost: +totalCost.toFixed(2),
      total_value: +totalValue.toFixed(2),
      cash: +cash.toFixed(2),
      total_pnl: +(totalValue - totalCost).toFixed(2),
      total_return_pct: totalCost > 0 ? +(((totalValue - totalCost) / totalCost) * 100).toFixed(2) : 0,
      portfolio_total: +(totalValue + cash).toFixed(2),
    },
  });
});

app.post('/api/portfolio/:id/positions', async (req, res) => {
  const id = parseInt(req.params.id);
  const { ticker, dollars } = req.body;
  if (!ticker || !dollars) return res.status(400).json({ error: 'ticker and dollars required' });

  const sym = ticker.toUpperCase();
  // Get current price
  const metrics = db.getLatestMetrics(sym)[0];
  let price = metrics?.price;

  if (!price) {
    try {
      const profile = await fmp.getProfile(sym);
      price = profile?.price;
    } catch (e) {
      return res.status(422).json({ error: `Could not get price for ${sym}` });
    }
  }
  if (!price) return res.status(422).json({ error: `No price data for ${sym}` });

  const portfolio = db.getPortfolios().find(p => p.id === id);
  if (!portfolio) return res.status(404).json({ error: 'Portfolio not found' });

  const shares = parseFloat((dollars / price).toFixed(6));
  db.upsertPosition(id, sym, shares, price);
  res.json({ ticker: sym, shares, price, cost: +dollars });
});

app.delete('/api/portfolio/:id/positions/:ticker', (req, res) => {
  db.removePosition(parseInt(req.params.id), req.params.ticker.toUpperCase());
  res.json({ success: true });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

if (process.env.NODE_ENV !== 'test') require('./scheduler');

app.listen(PORT, () => {
  console.log(`FinPredict running at http://localhost:${PORT}`);
  console.log('FMP API:', process.env.FMP_API_KEY ? '✓' : '✗ missing');
  console.log('Google AI:', process.env.GOOGLE_AI_KEY !== 'your_google_ai_studio_key_here' ? '✓' : '✗ not set');

  // Auto-refresh on startup if no scores exist yet (e.g. fresh Render deploy)
  const companies = db.getCompanies('candidate');
  const hasScores = companies.some(c => db.getLatestScore(c.ticker));
  if (!hasScores && companies.length > 0) {
    console.log('No scores found — triggering background refresh...');
    scoreAll(false).catch(err => console.error('Startup refresh failed:', err.message));
  }
});
