require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'finpredict.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'candidate',
    sector TEXT,
    seed_tier TEXT,
    seed_score REAL,
    peak_return TEXT,
    growth_window TEXT,
    flagged INTEGER DEFAULT 0,
    flagged_reason TEXT,
    synopsis TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    market_cap REAL,
    revenue_ttm REAL,
    revenue_prev REAL,
    revenue_growth_yoy REAL,
    gross_margin REAL,
    gross_margin_prev REAL,
    gross_margin_expanding INTEGER,
    fcf REAL,
    fcf_per_share REAL,
    fcf_per_share_prev REAL,
    cash REAL,
    total_debt REAL,
    ps_ratio REAL,
    pe_ratio REAL,
    shares_outstanding REAL,
    UNIQUE(ticker, date)
  );

  CREATE TABLE IF NOT EXISTS qualitative_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    tam_large REAL DEFAULT 0,
    tam_reasoning TEXT,
    recurring_revenue REAL DEFAULT 0,
    recurring_revenue_reasoning TEXT,
    network_effects REAL DEFAULT 0,
    network_effects_reasoning TEXT,
    founder_led REAL DEFAULT 0,
    founder_led_reasoning TEXT,
    nrr_120 REAL DEFAULT 0,
    nrr_120_reasoning TEXT,
    category_creator REAL DEFAULT 0,
    category_creator_reasoning TEXT,
    customer_concentration REAL DEFAULT 0,
    customer_concentration_reasoning TEXT,
    UNIQUE(ticker, date)
  );

  CREATE TABLE IF NOT EXISTS composite_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    c1_tam_large REAL DEFAULT 0,
    c2_revenue_growth REAL DEFAULT 0,
    c3_gross_margin REAL DEFAULT 0,
    c4_recurring_revenue REAL DEFAULT 0,
    c5_network_effects REAL DEFAULT 0,
    c6_founder_led REAL DEFAULT 0,
    c7_nrr_120 REAL DEFAULT 0,
    c8_fcf_positive REAL DEFAULT 0,
    c9_margin_expanding REAL DEFAULT 0,
    c10_category_creator REAL DEFAULT 0,
    c11_low_valuation REAL DEFAULT 0,
    c12_strong_balance REAL DEFAULT 0,
    c13_insider_ownership REAL DEFAULT 0,
    c14_fcf_per_share REAL DEFAULT 0,
    c15_no_concentration REAL DEFAULT 0,
    total_score REAL DEFAULT 0,
    tier TEXT,
    UNIQUE(ticker, date)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    UNIQUE(ticker, date)
  );

  CREATE TABLE IF NOT EXISTS portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'My Portfolio',
    starting_cash REAL NOT NULL DEFAULT 10000,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS portfolio_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolio_id INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    shares REAL NOT NULL,
    avg_cost_per_share REAL NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(portfolio_id, ticker),
    FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS refresh_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,
    status TEXT,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrate existing DBs: add new columns if missing
['flagged_reason TEXT', 'synopsis TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE companies ADD COLUMN ${col}`); } catch (_) {}
});

// ── Company helpers ───────────────────────────────────────────────────────────

function getCompanies(category) {
  if (category) return db.prepare('SELECT * FROM companies WHERE category = ?').all(category);
  return db.prepare('SELECT * FROM companies').all();
}

function getCompany(ticker) {
  return db.prepare('SELECT * FROM companies WHERE ticker = ?').get(ticker);
}

function upsertCompany(data) {
  db.prepare(`
    INSERT INTO companies (ticker, name, category, sector, seed_tier, seed_score,
      peak_return, growth_window, flagged, flagged_reason, synopsis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      name = excluded.name, sector = excluded.sector,
      flagged = excluded.flagged, flagged_reason = excluded.flagged_reason,
      synopsis = excluded.synopsis
  `).run(
    data.ticker, data.name, data.category || 'candidate', data.sector || null,
    data.seed_tier || null, data.seed_score || null,
    data.peak_return || null, data.growth_window || null,
    data.flagged || 0, data.flagged_reason || null, data.synopsis || null
  );
}

function updateSynopsis(ticker, synopsis) {
  db.prepare('UPDATE companies SET synopsis = ? WHERE ticker = ?').run(synopsis, ticker);
}

// ── Metrics helpers ───────────────────────────────────────────────────────────

function upsertDailyMetrics(ticker, date, data) {
  db.prepare(`
    INSERT INTO daily_metrics
      (ticker, date, price, market_cap, revenue_ttm, revenue_prev, revenue_growth_yoy,
       gross_margin, gross_margin_prev, gross_margin_expanding, fcf, fcf_per_share,
       fcf_per_share_prev, cash, total_debt, ps_ratio, pe_ratio, shares_outstanding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      price = excluded.price, market_cap = excluded.market_cap,
      revenue_ttm = excluded.revenue_ttm, revenue_prev = excluded.revenue_prev,
      revenue_growth_yoy = excluded.revenue_growth_yoy,
      gross_margin = excluded.gross_margin, gross_margin_prev = excluded.gross_margin_prev,
      gross_margin_expanding = excluded.gross_margin_expanding,
      fcf = excluded.fcf, fcf_per_share = excluded.fcf_per_share,
      fcf_per_share_prev = excluded.fcf_per_share_prev,
      cash = excluded.cash, total_debt = excluded.total_debt,
      ps_ratio = excluded.ps_ratio, pe_ratio = excluded.pe_ratio,
      shares_outstanding = excluded.shares_outstanding
  `).run(
    ticker, date,
    data.price ?? null, data.market_cap ?? null,
    data.revenue_ttm ?? null, data.revenue_prev ?? null, data.revenue_growth_yoy ?? null,
    data.gross_margin ?? null, data.gross_margin_prev ?? null, data.gross_margin_expanding ?? null,
    data.fcf ?? null, data.fcf_per_share ?? null, data.fcf_per_share_prev ?? null,
    data.cash ?? null, data.total_debt ?? null,
    data.ps_ratio ?? null, data.pe_ratio ?? null, data.shares_outstanding ?? null
  );
}

function upsertQualitativeScores(ticker, date, data) {
  db.prepare(`
    INSERT INTO qualitative_scores
      (ticker, date, tam_large, tam_reasoning, recurring_revenue, recurring_revenue_reasoning,
       network_effects, network_effects_reasoning, founder_led, founder_led_reasoning,
       nrr_120, nrr_120_reasoning, category_creator, category_creator_reasoning,
       customer_concentration, customer_concentration_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      tam_large = excluded.tam_large, tam_reasoning = excluded.tam_reasoning,
      recurring_revenue = excluded.recurring_revenue,
      recurring_revenue_reasoning = excluded.recurring_revenue_reasoning,
      network_effects = excluded.network_effects,
      network_effects_reasoning = excluded.network_effects_reasoning,
      founder_led = excluded.founder_led, founder_led_reasoning = excluded.founder_led_reasoning,
      nrr_120 = excluded.nrr_120, nrr_120_reasoning = excluded.nrr_120_reasoning,
      category_creator = excluded.category_creator,
      category_creator_reasoning = excluded.category_creator_reasoning,
      customer_concentration = excluded.customer_concentration,
      customer_concentration_reasoning = excluded.customer_concentration_reasoning
  `).run(
    ticker, date,
    data.tam_large ?? 0, data.tam_reasoning ?? '',
    data.recurring_revenue ?? 0, data.recurring_revenue_reasoning ?? '',
    data.network_effects ?? 0, data.network_effects_reasoning ?? '',
    data.founder_led ?? 0, data.founder_led_reasoning ?? '',
    data.nrr_120 ?? 0, data.nrr_120_reasoning ?? '',
    data.category_creator ?? 0, data.category_creator_reasoning ?? '',
    data.customer_concentration ?? 0, data.customer_concentration_reasoning ?? ''
  );
}

function upsertCompositeScore(ticker, date, data) {
  db.prepare(`
    INSERT INTO composite_scores
      (ticker, date, c1_tam_large, c2_revenue_growth, c3_gross_margin, c4_recurring_revenue,
       c5_network_effects, c6_founder_led, c7_nrr_120, c8_fcf_positive, c9_margin_expanding,
       c10_category_creator, c11_low_valuation, c12_strong_balance, c13_insider_ownership,
       c14_fcf_per_share, c15_no_concentration, total_score, tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker, date) DO UPDATE SET
      c1_tam_large = excluded.c1_tam_large, c2_revenue_growth = excluded.c2_revenue_growth,
      c3_gross_margin = excluded.c3_gross_margin, c4_recurring_revenue = excluded.c4_recurring_revenue,
      c5_network_effects = excluded.c5_network_effects, c6_founder_led = excluded.c6_founder_led,
      c7_nrr_120 = excluded.c7_nrr_120, c8_fcf_positive = excluded.c8_fcf_positive,
      c9_margin_expanding = excluded.c9_margin_expanding, c10_category_creator = excluded.c10_category_creator,
      c11_low_valuation = excluded.c11_low_valuation, c12_strong_balance = excluded.c12_strong_balance,
      c13_insider_ownership = excluded.c13_insider_ownership, c14_fcf_per_share = excluded.c14_fcf_per_share,
      c15_no_concentration = excluded.c15_no_concentration,
      total_score = excluded.total_score, tier = excluded.tier
  `).run(
    ticker, date,
    data.c1_tam_large ?? 0, data.c2_revenue_growth ?? 0, data.c3_gross_margin ?? 0,
    data.c4_recurring_revenue ?? 0, data.c5_network_effects ?? 0, data.c6_founder_led ?? 0,
    data.c7_nrr_120 ?? 0, data.c8_fcf_positive ?? 0, data.c9_margin_expanding ?? 0,
    data.c10_category_creator ?? 0, data.c11_low_valuation ?? 0, data.c12_strong_balance ?? 0,
    data.c13_insider_ownership ?? 0, data.c14_fcf_per_share ?? 0, data.c15_no_concentration ?? 0,
    data.total_score ?? 0, data.tier ?? 'Weak'
  );
}

function getLatestScore(ticker) {
  return db.prepare(`
    SELECT cs.*, dm.price, dm.market_cap, dm.revenue_growth_yoy, dm.gross_margin,
           dm.ps_ratio, dm.fcf, dm.cash, dm.total_debt
    FROM composite_scores cs
    LEFT JOIN daily_metrics dm ON cs.ticker = dm.ticker AND cs.date = dm.date
    WHERE cs.ticker = ?
    ORDER BY cs.date DESC LIMIT 1
  `).get(ticker);
}

function getScoreHistory(ticker, days = 90) {
  return db.prepare(`
    SELECT date, total_score, tier, c1_tam_large, c2_revenue_growth, c3_gross_margin,
           c4_recurring_revenue, c5_network_effects, c6_founder_led, c7_nrr_120,
           c8_fcf_positive, c9_margin_expanding, c10_category_creator, c11_low_valuation,
           c12_strong_balance, c13_insider_ownership, c14_fcf_per_share, c15_no_concentration
    FROM composite_scores WHERE ticker = ?
    ORDER BY date DESC LIMIT ?
  `).all(ticker, days);
}

function getPriceHistory(ticker, days = 365) {
  return db.prepare(`
    SELECT date, price FROM price_history
    WHERE ticker = ? ORDER BY date ASC LIMIT ?
  `).all(ticker, days);
}

function getLatestQualitative(ticker) {
  return db.prepare(`
    SELECT * FROM qualitative_scores WHERE ticker = ? ORDER BY date DESC LIMIT 1
  `).get(ticker);
}

function getLatestMetrics(ticker) {
  return db.prepare(`
    SELECT * FROM daily_metrics WHERE ticker = ? ORDER BY date DESC LIMIT 2
  `).all(ticker);
}

// ── Portfolio helpers ─────────────────────────────────────────────────────────

function getOrCreateDefaultPortfolio() {
  let p = db.prepare('SELECT * FROM portfolios LIMIT 1').get();
  if (!p) {
    db.prepare("INSERT INTO portfolios (name, starting_cash) VALUES ('My Portfolio', 10000)").run();
    p = db.prepare('SELECT * FROM portfolios LIMIT 1').get();
  }
  return p;
}

function getPortfolios() {
  return db.prepare('SELECT * FROM portfolios ORDER BY created_at DESC').all();
}

function createPortfolio(name, startingCash) {
  db.prepare('INSERT INTO portfolios (name, starting_cash) VALUES (?, ?)').run(name, startingCash);
  return db.prepare('SELECT * FROM portfolios ORDER BY id DESC LIMIT 1').get();
}

function getPortfolioPositions(portfolioId) {
  return db.prepare(`
    SELECT pp.*, c.name as company_name, c.sector,
           dm.price as current_price, dm.market_cap
    FROM portfolio_positions pp
    LEFT JOIN companies c ON pp.ticker = c.ticker
    LEFT JOIN (
      SELECT ticker, price FROM daily_metrics
      WHERE (ticker, date) IN (
        SELECT ticker, MAX(date) FROM daily_metrics GROUP BY ticker
      )
    ) dm ON pp.ticker = dm.ticker
    WHERE pp.portfolio_id = ?
  `).all(portfolioId);
}

function upsertPosition(portfolioId, ticker, shares, avgCost) {
  db.prepare(`
    INSERT INTO portfolio_positions (portfolio_id, ticker, shares, avg_cost_per_share)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(portfolio_id, ticker) DO UPDATE SET
      shares = portfolio_positions.shares + excluded.shares,
      avg_cost_per_share = (
        (portfolio_positions.shares * portfolio_positions.avg_cost_per_share + excluded.shares * excluded.avg_cost_per_share)
        / (portfolio_positions.shares + excluded.shares)
      )
  `).run(portfolioId, ticker, shares, avgCost);
}

function removePosition(portfolioId, ticker) {
  db.prepare('DELETE FROM portfolio_positions WHERE portfolio_id = ? AND ticker = ?').run(portfolioId, ticker);
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function logRefresh(type, status, message) {
  db.prepare('INSERT INTO refresh_log (type, status, message) VALUES (?, ?, ?)').run(type, status, message);
}

function getRefreshLog(limit = 20) {
  return db.prepare('SELECT * FROM refresh_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  getCompanies, getCompany, upsertCompany, updateSynopsis,
  upsertDailyMetrics, upsertQualitativeScores, upsertCompositeScore,
  getLatestScore, getScoreHistory, getPriceHistory,
  getLatestQualitative, getLatestMetrics,
  getOrCreateDefaultPortfolio, getPortfolios, createPortfolio,
  getPortfolioPositions, upsertPosition, removePosition,
  logRefresh, getRefreshLog,
};
