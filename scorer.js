require('dotenv').config();
const db = require('./db');
const fmp = require('./fmpClient');
const { scoreCompany } = require('./gemmaScorer');

// ── Tier thresholds ───────────────────────────────────────────────────────────
function getTier(score) {
  if (score >= 11) return 'Elite';
  if (score >= 9) return 'Strong';
  if (score >= 7) return 'Speculative';
  return 'Weak';
}

// ── Quantitative scoring rules ────────────────────────────────────────────────

function scoreRevenueGrowth(growthRate) {
  if (growthRate === null || growthRate === undefined) return 0.5; // neutral if no data
  if (growthRate >= 0.25) return 1;
  if (growthRate >= 0.10) return 0.5;
  return 0;
}

function scoreGrossMargin(margin) {
  if (margin === null || margin === undefined) return 0.5;
  if (margin >= 0.50) return 1;
  if (margin >= 0.35) return 0.5;
  return 0;
}

function scoreMarginExpanding(curr, prev) {
  if (curr === null || prev === null) return 0.5;
  const delta = curr - prev;
  if (delta > 0.01) return 1;
  if (delta > -0.01) return 0.5;
  return 0;
}

function scoreFCFPositive(fcf, revenue) {
  if (fcf === null) return 0.5;
  if (fcf > 0) return 1;
  // Slightly negative but within 10% of revenue — partial credit
  if (revenue && fcf > -(revenue * 0.10)) return 0.5;
  return 0;
}

function scoreFCFPerShare(current, previous) {
  if (current === null || previous === null) return 0.5;
  if (previous === 0) return current > 0 ? 1 : 0;
  const growth = (current - previous) / Math.abs(previous);
  if (growth > 0.10) return 1;
  if (growth > -0.10) return 0.5;
  return 0;
}

function scoreBalanceSheet(cash, debt) {
  if (cash === null || debt === null) return 0.5;
  if (debt === 0) return 1;
  const ratio = cash / debt;
  if (ratio >= 1) return 1;
  if (ratio >= 0.70) return 0.5;
  return 0;
}

function scoreValuation(psRatio, revenueGrowth) {
  if (psRatio === null) return 0.5;
  // Growth-adjusted: P/S / revenue_growth_pct — below 0.5x is cheap, above 1.5x is expensive
  if (revenueGrowth && revenueGrowth > 0) {
    const growthPct = revenueGrowth * 100;
    const psgRatio = psRatio / growthPct;
    if (psgRatio < 0.5) return 1;
    if (psgRatio < 1.5) return 0.5;
    return 0;
  }
  // Fallback: absolute P/S
  if (psRatio < 5) return 1;
  if (psRatio < 15) return 0.5;
  return 0;
}

// Insider ownership: use seed data + FMP form-4 heuristic
function scoreInsiderOwnership(ticker) {
  const SEED_OWNERSHIP = {
    DUOL: 1,   // Luis von Ahn ~35%
    NET: 1,    // Matthew Prince ~4% but Class B super-voting — partial
    APP: 1,    // Adam Foroughi ~28%
    AXON: 0.5, // Rick Smith meaningful but not controlling
    IOT: 1,    // Sanjit Biswas founder-CEO
    MELI: 0.5, // Founders involved, no controlling stake
    TOST: 0.5,
    CRDO: 1,   // Founder-led small cap
    RXRX: 1,   // Chris Gibson founder ~significant
    JOBY: 1,   // JoeBen Bevirt founder ~significant
    BROS: 0,   // Travis Boersma sold $300M, low alignment
    RKLB: 0,   // CEO 0.71% ownership
  };
  return SEED_OWNERSHIP[ticker] ?? 0.5;
}

// ── Main scoring function for one ticker ──────────────────────────────────────

async function scoreTicker(ticker, useGemma = true) {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`[${ticker}] Fetching market data...`);

  let raw;
  try {
    raw = await fmp.fetchAllMetrics(ticker);
  } catch (err) {
    console.error(`[${ticker}] Data fetch failed:`, err.message);
    db.logRefresh('score', 'error', `${ticker}: data fetch failed — ${err.message}`);
    return null;
  }

  // ── Extract raw metrics ────────────────────────────────────────────────────
  const price = fmp.extractPrice(raw);
  const marketCap = fmp.extractMarketCap(raw);
  const revenueGrowth = fmp.extractRevenueGrowth(raw);
  const grossMargin = fmp.extractGrossMargin(raw);
  const grossMarginPrev = fmp.extractGrossMarginPrev(raw);
  const fcf = fmp.extractFCF(raw);
  const fcfPerShare = fmp.extractFCFPerShare(raw);
  const fcfPerSharePrev = fmp.extractFCFPerSharePrev(raw);
  const cash = fmp.extractCash(raw);
  const totalDebt = fmp.extractTotalDebt(raw);
  const psRatio = fmp.extractPSRatio(raw);
  const shares = fmp.extractSharesOutstanding(raw);
  const revenueTTM = fmp.extractRevenue(raw);
  const revenuePrev = fmp.extractPrevRevenue(raw);
  const grossMarginExpanding = grossMargin !== null && grossMarginPrev !== null
    ? (grossMargin - grossMarginPrev > 0.01 ? 1 : grossMargin - grossMarginPrev > -0.01 ? 0 : -1)
    : 0;

  // Save daily metrics
  db.upsertDailyMetrics(ticker, today, {
    price,
    market_cap: marketCap,
    revenue_ttm: revenueTTM,
    revenue_prev: revenuePrev,
    revenue_growth_yoy: revenueGrowth,
    gross_margin: grossMargin,
    gross_margin_prev: grossMarginPrev,
    gross_margin_expanding: grossMarginExpanding,
    fcf,
    fcf_per_share: fcfPerShare,
    fcf_per_share_prev: fcfPerSharePrev,
    cash,
    total_debt: totalDebt,
    ps_ratio: psRatio,
    pe_ratio: fmp.extractPEFromQuote(raw),
    shares_outstanding: shares,
  });

  // Save price history
  const priceHistory = raw.priceHistory || [];
  if (priceHistory.length > 0) {
    const insertPrice = db.db.prepare(
      'INSERT OR IGNORE INTO price_history (ticker, date, price) VALUES (?, ?, ?)'
    );
    for (const r of priceHistory.slice(0, 365)) {
      try {
        const dateStr = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
        insertPrice.run(ticker, dateStr, r.close ?? r.price);
      } catch (_) {}
    }
  }

  // ── Quantitative scores ────────────────────────────────────────────────────
  const c2 = scoreRevenueGrowth(revenueGrowth);
  const c3 = scoreGrossMargin(grossMargin);
  const c8 = scoreFCFPositive(fcf, revenueTTM);
  const c9 = scoreMarginExpanding(grossMargin, grossMarginPrev);
  const c11 = scoreValuation(psRatio, revenueGrowth);
  const c12 = scoreBalanceSheet(cash, totalDebt);
  const c13 = scoreInsiderOwnership(ticker);
  const c14 = scoreFCFPerShare(fcfPerShare, fcfPerSharePrev);

  // ── Qualitative scores (Gemma or use latest stored) ───────────────────────
  let qual = db.getLatestQualitative(ticker);

  if (useGemma) {
    console.log(`[${ticker}] Running Gemma qualitative scoring...`);
    try {
      const gemmaScores = await scoreCompany(ticker, profile?.companyName || ticker);
      if (gemmaScores) {
        db.upsertQualitativeScores(ticker, today, gemmaScores);
        if (gemmaScores.synopsis) db.updateSynopsis(ticker, gemmaScores.synopsis);
        qual = gemmaScores;
      }
    } catch (err) {
      console.warn(`[${ticker}] Gemma scoring skipped:`, err.message);
    }
  }

  // Fall back to seed data if no qualitative scores exist
  if (!qual) {
    qual = getSeedQualitative(ticker);
    db.upsertQualitativeScores(ticker, today, qual);
  }

  const c1 = qual.tam_large ?? 0.5;
  const c4 = qual.recurring_revenue ?? 0.5;
  const c5 = qual.network_effects ?? 0.5;
  const c6 = qual.founder_led ?? 0.5;
  const c7 = qual.nrr_120 ?? 0;
  const c10 = qual.category_creator ?? 0.5;
  const c15 = qual.customer_concentration ?? 0.5;

  // ── Composite score ───────────────────────────────────────────────────────
  const total = +(c1 + c2 + c3 + c4 + c5 + c6 + c7 + c8 + c9 + c10 + c11 + c12 + c13 + c14 + c15).toFixed(1);
  const tier = getTier(total);

  db.upsertCompositeScore(ticker, today, {
    c1_tam_large: c1,
    c2_revenue_growth: c2,
    c3_gross_margin: c3,
    c4_recurring_revenue: c4,
    c5_network_effects: c5,
    c6_founder_led: c6,
    c7_nrr_120: c7,
    c8_fcf_positive: c8,
    c9_margin_expanding: c9,
    c10_category_creator: c10,
    c11_low_valuation: c11,
    c12_strong_balance: c12,
    c13_insider_ownership: c13,
    c14_fcf_per_share: c14,
    c15_no_concentration: c15,
    total_score: total,
    tier,
  });

  console.log(`[${ticker}] Score: ${total}/15 — ${tier}`);
  db.logRefresh('score', 'success', `${ticker}: ${total}/15 ${tier}`);
  return { ticker, total, tier };
}

// ── Seed qualitative data from PDF analysis ───────────────────────────────────
function getSeedQualitative(ticker) {
  const SEEDS = {
    DUOL: { tam_large: 1, tam_reasoning: 'Global language learning TAM $115B+, early-stage digital penetration', recurring_revenue: 1, recurring_revenue_reasoning: 'Subscription model (Super Duolingo, Duolingo Max)', network_effects: 0.5, network_effects_reasoning: 'Social leaderboards create some viral loops, not full platform network effects', founder_led: 1, founder_led_reasoning: 'Luis von Ahn ~35% ownership, active CEO since founding', nrr_120: 0.5, nrr_120_reasoning: 'Paid subscriber growth 34% YoY implies strong retention, NRR not directly disclosed', category_creator: 1, category_creator_reasoning: 'Created the mass-market gamified language learning category', customer_concentration: 1, customer_concentration_reasoning: 'Consumer subscription — no single customer concentration risk' },
    NET: { tam_large: 1, tam_reasoning: 'Cloud security and networking TAM $200B+ and expanding with AI traffic', recurring_revenue: 1, recurring_revenue_reasoning: 'SaaS subscription model with NRR accelerating to 120%', network_effects: 1, network_effects_reasoning: 'Handles 50%+ of global API traffic — adding one customer benefits all others', founder_led: 1, founder_led_reasoning: 'Matthew Prince is CEO and co-founder with strong long-term vision', nrr_120: 1, nrr_120_reasoning: 'NRR confirmed at 120% Q4 2025, accelerating from 111% Q1 2025', category_creator: 1, category_creator_reasoning: 'Created the cloud network security as a service category at scale', customer_concentration: 1, customer_concentration_reasoning: 'No material customer concentration, distributed SMB + enterprise base' },
    APP: { tam_large: 1, tam_reasoning: 'Mobile advertising TAM $400B+ globally', recurring_revenue: 0, recurring_revenue_reasoning: 'Performance-based ad spend is transactional, not subscription', network_effects: 1, network_effects_reasoning: 'Axon 2.0 AI engine improves with more data — true data flywheel moat', founder_led: 1, founder_led_reasoning: 'Adam Foroughi ~28% ownership, founder and CEO', nrr_120: 0.5, nrr_120_reasoning: 'App developer spend grows with AppLovin performance, but not traditional NRR structure', category_creator: 1, category_creator_reasoning: 'Created AI-native mobile performance advertising as a distinct category', customer_concentration: 0.5, customer_concentration_reasoning: 'Concentration in mobile gaming advertisers creates some sector risk' },
    AXON: { tam_large: 1, tam_reasoning: 'Public safety technology TAM $50B+ globally, international expansion early', recurring_revenue: 1, recurring_revenue_reasoning: 'Axon Cloud SaaS + hardware service contracts with NRR 125%', network_effects: 0.5, network_effects_reasoning: 'Data evidence sharing creates inter-agency network effects, early stage', founder_led: 1, founder_led_reasoning: 'Rick Smith is founder and CEO with clear long-term public safety mission', nrr_120: 1, nrr_120_reasoning: 'NRR confirmed at 125% and improving from sub-120% in 2023', category_creator: 1, category_creator_reasoning: 'Created the connected public safety operating system — body cams, evidence, records', customer_concentration: 0.5, customer_concentration_reasoning: 'Concentrated in US law enforcement — single-sector risk despite many agencies' },
    IOT: { tam_large: 1, tam_reasoning: 'Physical operations IoT/AI software TAM $100B+ across logistics, construction, energy', recurring_revenue: 1, recurring_revenue_reasoning: 'SaaS subscription with NRR ~115%, ARR $1.5B growing 30%+', network_effects: 0.5, network_effects_reasoning: 'Platform network effects emerging but still early versus ServiceNow maturity', founder_led: 1, founder_led_reasoning: 'Sanjit Biswas is co-founder and CEO', nrr_120: 0.5, nrr_120_reasoning: 'NRR consistently above 115%, not yet confirmed at 120%', category_creator: 1, category_creator_reasoning: 'Creating the physical operations platform category — ServiceNow for physical economy', customer_concentration: 1, customer_concentration_reasoning: 'No material customer concentration across 13,000+ enterprise customers' },
    MELI: { tam_large: 1, tam_reasoning: 'LatAm e-commerce + fintech TAM $500B+, 10-15 years behind US adoption', recurring_revenue: 0.5, recurring_revenue_reasoning: 'Marketplace GMV is transactional; Mercado Pago payments adds recurring fintech revenue', network_effects: 1, network_effects_reasoning: 'Marketplace flywheel: more buyers attract sellers attract buyers — strong network effects', founder_led: 0.5, founder_led_reasoning: 'Marcos Galperin is co-founder, CEO but no controlling stake', nrr_120: 0.5, nrr_120_reasoning: 'NRR not directly reported for marketplace model; cohort data implies strong retention', category_creator: 0.5, category_creator_reasoning: 'Dominant in LatAm but following proven playbook from Amazon/PayPal', customer_concentration: 1, customer_concentration_reasoning: '83M+ active buyers — no customer concentration in a marketplace model' },
    TOST: { tam_large: 1, tam_reasoning: 'Restaurant technology TAM $55B+ globally', recurring_revenue: 0.5, recurring_revenue_reasoning: 'Mix of fintech payments (transactional) and software subscriptions — gross margins only 26%', network_effects: 0.5, network_effects_reasoning: 'Payments + POS integration creates switching costs but not true network effects', founder_led: 1, founder_led_reasoning: 'Chris Comparato CEO, founder team still active', nrr_120: 0, nrr_120_reasoning: 'NRR not reported in traditional SaaS format; fintech-dominated revenue limits metric', category_creator: 1, category_creator_reasoning: 'Created the all-in-one restaurant technology platform category', customer_concentration: 1, customer_concentration_reasoning: 'No single customer concentration — distributed across SMB restaurants' },
    CRDO: { tam_large: 1, tam_reasoning: 'AI infrastructure connectivity TAM $30B+ growing rapidly with GPU cluster buildout', recurring_revenue: 0.5, recurring_revenue_reasoning: 'Hardware + IP licensing has some recurring royalty stream but not SaaS', network_effects: 0.5, network_effects_reasoning: 'IP portfolio and design-in wins create switching costs but no platform network effects', founder_led: 1, founder_led_reasoning: 'Bill Brennan and co-founders active in leadership', nrr_120: 0, nrr_120_reasoning: 'Not applicable — hardware/IP company without traditional NRR metrics', category_creator: 1, category_creator_reasoning: 'Created the high-speed AI cluster connectivity solutions category (AECs, SerDes)', customer_concentration: 0, customer_concentration_reasoning: 'Majority of revenue from 2-3 hyperscaler customers — severe concentration risk' },
    RXRX: { tam_large: 1, tam_reasoning: 'AI drug discovery TAM is effectively the entire $1.5T global pharma R&D spend', recurring_revenue: 0, recurring_revenue_reasoning: 'Pre-revenue on drug side; platform partnerships are early stage', network_effects: 0.5, network_effects_reasoning: 'Proprietary biological dataset (50+ petabytes) creates data moat that deepens with use', founder_led: 1, founder_led_reasoning: 'Chris Gibson is founder and CEO with strong scientific vision', nrr_120: 0, nrr_120_reasoning: 'Pre-revenue — NRR not applicable', category_creator: 1, category_creator_reasoning: 'Creating AI-native drug discovery as a scalable platform category', customer_concentration: 1, customer_concentration_reasoning: 'No revenue concentration risk at this stage; diversified partnership approach' },
    JOBY: { tam_large: 1, tam_reasoning: 'Urban air mobility TAM estimated $1T+ by 2040 by Morgan Stanley', recurring_revenue: 0, recurring_revenue_reasoning: 'Pre-revenue; future model will be per-ride or subscription, not yet established', network_effects: 0.5, network_effects_reasoning: 'Route density creates operational network effects but not platform effects', founder_led: 1, founder_led_reasoning: 'JoeBen Bevirt is founder and CEO with deep personal mission in clean transportation', nrr_120: 0, nrr_120_reasoning: 'Pre-revenue — NRR not applicable', category_creator: 1, category_creator_reasoning: 'Creating the electric urban air taxi category from scratch', customer_concentration: 1, customer_concentration_reasoning: 'No revenue yet — customer concentration not applicable' },
    BROS: { tam_large: 0.5, tam_reasoning: 'US specialty coffee TAM ~$50B but competitive and geography-limited', recurring_revenue: 0, recurring_revenue_reasoning: 'QSR transactions are purely transactional — no subscription revenue model', network_effects: 0.5, network_effects_reasoning: 'Dutch Rewards loyalty program creates some stickiness (60%+ attachment rate)', founder_led: 0.5, founder_led_reasoning: 'Travis Boersma founded the company but sold $300M in shares — alignment weakening', nrr_120: 0, nrr_120_reasoning: 'Not applicable — QSR restaurant model', category_creator: 0.5, category_creator_reasoning: 'Strong brand in Dutch-style coffee but not creating a new category', customer_concentration: 1, customer_concentration_reasoning: 'Consumer QSR — no single customer concentration' },
    RKLB: { tam_large: 1, tam_reasoning: 'Small satellite launch and space systems TAM $700B+ long-term', recurring_revenue: 0, recurring_revenue_reasoning: 'Launch services are project-based, not recurring; Space Systems has some repeat customers', network_effects: 0.5, network_effects_reasoning: 'Vertically integrated rocket production creates some cost advantages but no platform effects', founder_led: 1, founder_led_reasoning: 'Peter Beck is founder and CEO with visionary space ambitions', nrr_120: 0, nrr_120_reasoning: 'Launch services model — NRR not applicable', category_creator: 1, category_creator_reasoning: 'Created the dedicated small satellite launch market after SpaceX focused on large payloads', customer_concentration: 0.5, customer_concentration_reasoning: 'Concentration in government/defense contracts with a few key customers' },
  };
  return SEEDS[ticker] || {
    tam_large: 0.5, tam_reasoning: 'Unknown', recurring_revenue: 0.5, recurring_revenue_reasoning: 'Unknown',
    network_effects: 0.5, network_effects_reasoning: 'Unknown', founder_led: 0.5, founder_led_reasoning: 'Unknown',
    nrr_120: 0, nrr_120_reasoning: 'Unknown', category_creator: 0.5, category_creator_reasoning: 'Unknown',
    customer_concentration: 0.5, customer_concentration_reasoning: 'Unknown',
  };
}

// ── Score all candidates ──────────────────────────────────────────────────────
async function scoreAll(useGemma = false) {
  const companies = db.getCompanies('candidate');
  console.log(`Scoring ${companies.length} companies (Gemma: ${useGemma})...`);
  const results = [];
  for (const company of companies) {
    try {
      const result = await scoreTicker(company.ticker, useGemma);
      if (result) results.push(result);
    } catch (err) {
      console.error(`Failed to score ${company.ticker}:`, err.message);
    }
    await new Promise(r => setTimeout(r, 500)); // small delay between tickers
  }
  return results;
}

module.exports = { scoreTicker, scoreAll, getSeedQualitative, getTier };

// Run directly: node scorer.js --run-now
if (require.main === module) {
  const useGemma = process.argv.includes('--gemma');
  scoreAll(useGemma).then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
