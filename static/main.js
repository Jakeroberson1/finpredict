// ── State ─────────────────────────────────────────────────────────────────────
let allCompanies = [];
let selectedTicker = null;
let scoreChart = null;
let priceChart = null;
let projectionChart = null;
let allocationChart = null;
let currentPortfolioId = null;

const CRITERIA_META = [
  { key: 'c1', dbKey: 'c1_tam_large',         label: 'TAM > $50B',               category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c2', dbKey: 'c2_revenue_growth',     label: 'Revenue Growth >25%',       category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c3', dbKey: 'c3_gross_margin',       label: 'Gross Margin >50%',         category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c4', dbKey: 'c4_recurring_revenue',  label: 'Recurring Revenue',          category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c5', dbKey: 'c5_network_effects',    label: 'Network Effects',            category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c6', dbKey: 'c6_founder_led',        label: 'Founder-Led',               category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c7', dbKey: 'c7_nrr_120',            label: 'NRR > 120%',                category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c8', dbKey: 'c8_fcf_positive',       label: 'FCF Positive',              category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c9', dbKey: 'c9_margin_expanding',   label: 'Margin Expanding',          category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c10', dbKey: 'c10_category_creator', label: 'Category Creator',          category: 'Qualitative', source: 'Gemma AI' },
  { key: 'c11', dbKey: 'c11_low_valuation',    label: 'Low Valuation vs Growth',   category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c12', dbKey: 'c12_strong_balance',   label: 'Strong Balance Sheet',      category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c13', dbKey: 'c13_insider_ownership',label: 'Insider Ownership >10%',    category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c14', dbKey: 'c14_fcf_per_share',    label: 'FCF/Share Growing',         category: 'Quantitative', source: 'FMP Daily' },
  { key: 'c15', dbKey: 'c15_no_concentration', label: 'No Customer >15%',          category: 'Qualitative', source: 'Gemma AI' },
];

const QUAL_REASONING_MAP = {
  1: 'tam_reasoning', 4: 'recurring_revenue_reasoning', 5: 'network_effects_reasoning',
  6: 'founder_led_reasoning', 7: 'nrr_120_reasoning', 10: 'category_creator_reasoning', 15: 'customer_concentration_reasoning',
};

// ── Init ──────────────────────────────────────────────────────────────────────
let _pollTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  loadCandidates();
  loadHistorical();
});

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    const res = await fetch('/api/companies').then(r => r.json()).catch(() => []);
    const hasScores = res.some(c => c.current_score);
    if (hasScores) {
      clearInterval(_pollTimer);
      _pollTimer = null;
      loadCandidates();
    }
  }, 5000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  el.classList.add('active');
  if (name === 'portfolio') loadPortfolio();
  if (name === 'projector') loadProjectorTickers();
}

// ── Candidates ────────────────────────────────────────────────────────────────
async function loadCandidates() {
  try {
    const res = await fetch('/api/companies');
    allCompanies = await res.json();
    renderCandidates(allCompanies);
    updateSummaryBar(allCompanies);
    updateLastUpdated(allCompanies);
  } catch {
    document.getElementById('company-grid').innerHTML =
      `<div class="loading" style="color:var(--weak)">Failed to load. Is the server running?</div>`;
  }
}

function renderCandidates(companies) {
  const grid = document.getElementById('company-grid');
  if (!companies.length || !companies.some(c => c.current_score)) {
    grid.innerHTML = '<div class="loading"><div class="spinner"></div> Fetching live data — this takes about a minute on first load...</div>';
    startPolling();
    return;
  }
  grid.innerHTML = companies.map(c => {
    const score = c.current_score ?? 0;
    const tier = c.tier || 'Weak';
    const pct = ((score / 15) * 100).toFixed(1);
    const priceStr = c.price ? `$${c.price.toFixed(2)}` : '—';
    const chg = c.price_change_pct;
    const chgStr = chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—';
    const chgCls = chg != null ? (chg >= 0 ? 'positive' : 'negative') : '';
    const mcap = c.market_cap ? fmtM(c.market_cap) : '—';
    const dots = c.criteria
      ? CRITERIA_META.map(m => {
          const v = c.criteria[m.key];
          const cls = v === 1 ? 'score-1' : v === 0.5 ? 'score-05' : 'score-0';
          return `<div class="criteria-dot ${cls}" title="${m.label}: ${v ?? 0}"></div>`;
        }).join('')
      : CRITERIA_META.map(() => '<div class="criteria-dot score-0"></div>').join('');

    return `
      <div class="company-card ${c.flagged ? 'flagged' : ''} ${selectedTicker === c.ticker ? 'selected' : ''}"
           onclick="selectCompany('${c.ticker}', this)">
        <div class="card-header">
          <div>
            <div class="card-ticker">${c.ticker}</div>
            <div class="card-name">${c.name}</div>
          </div>
          <div class="tier-badge ${tier}">${tier}</div>
        </div>
        ${c.flagged ? `<div class="flagged-tag">⚠ Flagged — see details</div>` : ''}
        ${c.synopsis ? `<div class="card-synopsis">${c.synopsis}</div>` : ''}
        <div class="score-row">
          <span class="score-big">${score.toFixed(1)}</span>
          <span class="score-max">/ 15</span>
        </div>
        <div class="score-bar-bg"><div class="score-bar-fill ${tier}" style="width:${pct}%"></div></div>
        <div class="card-metrics">
          <div class="metric"><div class="metric-label">Price</div><div class="metric-value">${priceStr}</div></div>
          <div class="metric"><div class="metric-label">1-Day</div><div class="metric-value ${chgCls}">${chgStr}</div></div>
          <div class="metric"><div class="metric-label">Mkt Cap</div><div class="metric-value">${mcap}</div></div>
        </div>
        <div class="criteria-dots" title="15 criteria">${dots}</div>
      </div>`;
  }).join('');
}

function updateSummaryBar(companies) {
  document.getElementById('cnt-elite').textContent = companies.filter(c => c.tier === 'Elite').length;
  document.getElementById('cnt-strong').textContent = companies.filter(c => c.tier === 'Strong').length;
  document.getElementById('cnt-spec').textContent = companies.filter(c => c.tier === 'Speculative').length;
  const avg = companies.reduce((s, c) => s + (c.current_score || 0), 0) / (companies.length || 1);
  document.getElementById('avg-score').textContent = avg.toFixed(1);
}

function updateLastUpdated(companies) {
  const dates = companies.map(c => c.last_updated).filter(Boolean).sort();
  const latest = dates[dates.length - 1];
  document.getElementById('last-updated').textContent = latest ? `Updated: ${latest}` : 'Pending';
}

// ── Detail panel ──────────────────────────────────────────────────────────────
async function selectCompany(ticker, cardEl) {
  if (selectedTicker === ticker) {
    selectedTicker = null;
    document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
    closeDetail();
    return;
  }
  selectedTicker = ticker;
  document.querySelectorAll('.company-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');

  const panel = document.getElementById('detail-panel');
  panel.classList.add('visible');
  panel.innerHTML = '<div class="loading"><div class="spinner"></div> Loading detail...</div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const res = await fetch(`/api/companies/${ticker}`);
    const data = await res.json();
    renderDetailPanel(data, panel);
  } catch {
    panel.innerHTML = `<div class="loading" style="color:var(--weak)">Failed to load ${ticker}</div>`;
  }
}

function closeDetail() {
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('visible');
  panel.innerHTML = '';
  if (scoreChart) { scoreChart.destroy(); scoreChart = null; }
  if (priceChart) { priceChart.destroy(); priceChart = null; }
}

function renderDetailPanel(data, panel) {
  const { company, score, scoreHistory, priceHistory, qualitative, metrics } = data;
  const tier = score?.tier || company.seed_tier || 'Weak';
  const totalScore = score?.total_score ?? company.seed_score ?? 0;

  const criteriaRows = CRITERIA_META.map((m, i) => {
    const n = i + 1;
    const v = score ? (score[m.dbKey] ?? 0) : 0;
    const chipClass = v === 1 ? 'score-1' : v === 0.5 ? 'score-05' : 'score-0';
    const chipLabel = v === 1 ? '✓ 1.0' : v === 0.5 ? '~ 0.5' : '✗ 0';
    const reasoning = qualitative ? (qualitative[QUAL_REASONING_MAP[n]] || '') : '';
    return `
      <tr>
        <td class="crit-num">C${n}</td>
        <td>
          <div class="crit-name">${m.label}</div>
          <div class="crit-category">${m.category} · ${m.source}</div>
          ${reasoning ? `<div class="crit-reasoning">${reasoning}</div>` : ''}
        </td>
        <td class="crit-score-cell"><span class="crit-chip ${chipClass}">${chipLabel}</span></td>
      </tr>`;
  }).join('');

  const fmtPct = v => v != null ? `${(v * 100).toFixed(1)}%` : '—';
  const fmtX = v => v != null ? `${v.toFixed(1)}x` : '—';

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-title">
          ${company.name}
          <span style="color:var(--muted);font-size:17px;font-weight:400">(${company.ticker})</span>
          <span class="tier-badge ${tier}" style="vertical-align:middle;margin-left:10px">${tier}</span>
        </div>
        <div class="detail-subtitle">${company.sector || ''} · Updated: ${score?.date || 'Pending'}</div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="text-align:right">
          <span style="font-size:36px;font-weight:800">${totalScore.toFixed(1)}</span>
          <span style="font-size:17px;color:var(--muted)"> / 15</span>
        </div>
        <button class="detail-close" onclick="closeDetail()">✕ Close</button>
      </div>
    </div>

    ${company.flagged && company.flagged_reason ? `
      <div class="flag-reason-box">
        <strong>⚠ Why This Stock is Flagged</strong>
        <p>${company.flagged_reason}</p>
      </div>` : ''}

    ${company.synopsis ? `
      <div class="synopsis-box">
        <div class="synopsis-label">🤖 AI Analysis — Why This Stock Was Selected</div>
        <p>${company.synopsis}</p>
      </div>` : ''}

    <div class="detail-body">
      <div>
        <div class="detail-section">
          <div class="section-title">15-Criterion Breakdown</div>
          <table class="criteria-table">
            <thead><tr><th>#</th><th>Criterion</th><th style="text-align:center">Score</th></tr></thead>
            <tbody>${criteriaRows}</tbody>
          </table>
        </div>
      </div>
      <div>
        <div class="detail-section">
          <div class="section-title">Key Metrics</div>
          <div class="metrics-grid">
            <div class="metric-card"><div class="label">Price</div><div class="value">${metrics?.price ? '$' + metrics.price.toFixed(2) : '—'}</div><div class="sub">Current</div></div>
            <div class="metric-card"><div class="label">Market Cap</div><div class="value">${fmtM(metrics?.market_cap)}</div><div class="sub">USD</div></div>
            <div class="metric-card"><div class="label">Revenue Growth</div><div class="value">${fmtPct(metrics?.revenue_growth_yoy)}</div><div class="sub">YoY</div></div>
            <div class="metric-card"><div class="label">Gross Margin</div><div class="value">${fmtPct(metrics?.gross_margin)}</div><div class="sub">Trailing annual</div></div>
            <div class="metric-card"><div class="label">P/S Ratio</div><div class="value">${fmtX(metrics?.ps_ratio)}</div><div class="sub">Price / Sales</div></div>
            <div class="metric-card"><div class="label">FCF</div><div class="value">${metrics?.fcf ? fmtM(metrics.fcf) : '—'}</div><div class="sub">Free cash flow</div></div>
          </div>
        </div>
        ${priceHistory && priceHistory.length > 5 ? `
          <div class="detail-section">
            <div class="section-title">Price History (1 Year)</div>
            <div class="chart-container"><canvas id="price-chart"></canvas></div>
          </div>` : ''}
        ${scoreHistory && scoreHistory.length > 1 ? `
          <div class="detail-section">
            <div class="section-title">Score History</div>
            <div class="chart-container"><canvas id="score-chart"></canvas></div>
          </div>` : ''}
      </div>
    </div>`;

  if (priceHistory && priceHistory.length > 5) renderPriceChart(priceHistory);
  if (scoreHistory && scoreHistory.length > 1) renderScoreChart(scoreHistory);
}

// ── Charts ────────────────────────────────────────────────────────────────────
function renderPriceChart(history) {
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  const el = document.getElementById('price-chart');
  if (!el) return;
  const prices = history.map(p => p.price);
  const isUp = prices[prices.length - 1] >= prices[0];
  priceChart = new Chart(el, {
    type: 'line',
    data: {
      labels: history.map(p => p.date),
      datasets: [{ data: prices, borderColor: isUp ? '#2d9b6f' : '#c0392b', backgroundColor: isUp ? 'rgba(45,155,111,0.07)' : 'rgba(192,57,43,0.07)', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 11 } } }, y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 11 }, callback: v => '$' + v.toFixed(0) } } } }
  });
}

function renderScoreChart(history) {
  if (scoreChart) { scoreChart.destroy(); scoreChart = null; }
  const el = document.getElementById('score-chart');
  if (!el) return;
  const sorted = [...history].reverse();
  scoreChart = new Chart(el, {
    type: 'line',
    data: {
      labels: sorted.map(s => s.date),
      datasets: [{ data: sorted.map(s => s.total_score), borderColor: '#1a6b4a', backgroundColor: 'rgba(26,107,74,0.08)', borderWidth: 2, pointRadius: 3, pointBackgroundColor: '#1a6b4a', fill: true, tension: 0.2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 11 } } }, y: { min: 0, max: 15, ticks: { font: { size: 11 }, stepSize: 3 } } } }
  });
}

// ── Historical ────────────────────────────────────────────────────────────────
async function loadHistorical() {
  try {
    const res = await fetch('/api/historical');
    renderHistorical(await res.json());
  } catch {
    document.getElementById('hist-tbody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--muted)">Failed to load</td></tr>';
  }
}

function renderHistorical(companies) {
  const max = Math.max(...companies.map(c => parseRet(c.peak_return)));
  const colors = { Technology: '#3b7fc4', Consumer: '#e67e22', Healthcare: '#27ae60', Industrials: '#8e44ad', Travel: '#9b59b6' };
  document.getElementById('hist-tbody').innerHTML = companies.map(c => {
    const ret = parseRet(c.peak_return);
    const w = ((Math.log10(ret) - Math.log10(1000)) / (Math.log10(max) - Math.log10(1000)) * 100).toFixed(1);
    const col = colors[c.sector] || '#1a6b4a';
    return `<tr>
      <td><strong>${c.name}</strong></td>
      <td style="font-weight:700;color:var(--muted)">${c.ticker}</td>
      <td><span style="padding:2px 8px;background:${col}18;color:${col};border-radius:4px;font-size:12px;font-weight:600">${c.sector}</span></td>
      <td style="color:var(--muted)">${c.growth_window}</td>
      <td class="return-pct">${c.peak_return}</td>
      <td><div class="return-bar-bg"><div class="return-bar-fill" style="width:${w}%;background:${col}"></div></div></td>
      <td><strong>${(c.seed_score || 0).toFixed(1)}</strong><span style="color:var(--muted)">/10</span></td>
    </tr>`;
  }).join('');
}

// ── Portfolio Simulator ───────────────────────────────────────────────────────
async function loadPortfolio() {
  try {
    const pRes = await fetch('/api/portfolio');
    const portfolios = await pRes.json();
    if (!portfolios.length) return;
    currentPortfolioId = portfolios[0].id;
    refreshPortfolioView();
  } catch (e) {
    console.error('Portfolio load failed:', e);
  }
}

async function refreshPortfolioView() {
  if (!currentPortfolioId) return;
  try {
    const res = await fetch(`/api/portfolio/${currentPortfolioId}/positions`);
    const data = await res.json();
    renderPortfolioSummary(data.summary, data.portfolio);
    renderHoldings(data.positions);
    renderAllocationChart(data.positions);
  } catch (e) {
    console.error('Portfolio refresh failed:', e);
  }
}

function renderPortfolioSummary(s, portfolio) {
  const pnlPos = s.total_pnl >= 0;
  document.getElementById('ps-total').textContent = fmtDollar(s.portfolio_total);
  document.getElementById('ps-invested').textContent = fmtDollar(s.total_cost);
  document.getElementById('ps-cash').textContent = fmtDollar(s.cash);
  document.getElementById('ps-pnl').innerHTML = `<span style="color:${pnlPos ? 'var(--strong)' : 'var(--weak)'}">${pnlPos ? '+' : ''}${fmtDollar(s.total_pnl)}</span>`;
  document.getElementById('ps-return').innerHTML = `<span style="color:${pnlPos ? 'var(--strong)' : 'var(--weak)'}">${pnlPos ? '+' : ''}${s.total_return_pct}%</span>`;
}

function renderHoldings(positions) {
  const wrap = document.getElementById('holdings-table-wrap');
  if (!positions.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)">No positions yet.<br>Click "+ Add Position" to invest your virtual $${fmtDollar(10000)}.</div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="holdings-table">
      <thead><tr><th>Stock</th><th>Shares</th><th>Cost</th><th>Value</th><th>P&L</th><th>Return</th><th></th></tr></thead>
      <tbody>${positions.map(p => {
        const pnlPos = p.pnl >= 0;
        const pnlColor = pnlPos ? 'var(--strong)' : 'var(--weak)';
        return `<tr>
          <td><div class="ticker-cell">${p.ticker}</div><div class="name-cell">${p.company_name || ''}</div></td>
          <td>${p.shares.toFixed(4)}</td>
          <td>$${p.avg_cost_per_share.toFixed(2)}/sh<br><span style="color:var(--muted);font-size:11px">${fmtDollar(p.cost_basis)} total</span></td>
          <td style="font-weight:600">${fmtDollar(p.current_value)}</td>
          <td style="color:${pnlColor};font-weight:600">${pnlPos ? '+' : ''}${fmtDollar(p.pnl)}</td>
          <td style="color:${pnlColor};font-weight:700">${pnlPos ? '+' : ''}${p.pnl_pct}%</td>
          <td><button class="btn btn-danger" onclick="removePosition('${p.ticker}')">✕</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function renderAllocationChart(positions) {
  if (allocationChart) { allocationChart.destroy(); allocationChart = null; }
  const el = document.getElementById('allocation-chart');
  if (!el || !positions.length) return;
  const colors = ['#1a6b4a','#2d9b6f','#3b7fc4','#e67e22','#8e44ad','#c0392b','#f39c12','#16a085','#2980b9','#8e44ad'];
  allocationChart = new Chart(el, {
    type: 'doughnut',
    data: {
      labels: positions.map(p => p.ticker),
      datasets: [{ data: positions.map(p => p.current_value), backgroundColor: colors.slice(0, positions.length), borderWidth: 2, borderColor: '#fff' }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 12 }, padding: 12 } } } }
  });
}

function openAddPosition() {
  document.getElementById('add-pos-result').textContent = '';
  document.getElementById('pos-ticker').value = '';
  document.getElementById('pos-dollars').value = '';
  document.getElementById('add-position-modal').classList.add('open');
  document.getElementById('pos-ticker').focus();
}

async function addPosition() {
  const ticker = document.getElementById('pos-ticker').value.toUpperCase().trim();
  const dollars = parseFloat(document.getElementById('pos-dollars').value);
  const resultEl = document.getElementById('add-pos-result');

  if (!ticker || !dollars || dollars <= 0) {
    resultEl.innerHTML = '<span style="color:var(--weak)">Please enter a ticker and dollar amount.</span>';
    return;
  }

  resultEl.textContent = 'Adding position...';
  try {
    const res = await fetch(`/api/portfolio/${currentPortfolioId}/positions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, dollars }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    resultEl.innerHTML = `<span style="color:var(--strong)">✓ Bought ${data.shares.toFixed(4)} shares of ${data.ticker} at $${data.price.toFixed(2)}</span>`;
    setTimeout(() => { closeModal('add-position-modal'); refreshPortfolioView(); }, 1500);
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--weak)">Error: ${e.message}</span>`;
  }
}

async function removePosition(ticker) {
  if (!confirm(`Remove ${ticker} from portfolio?`)) return;
  await fetch(`/api/portfolio/${currentPortfolioId}/positions/${ticker}`, { method: 'DELETE' });
  refreshPortfolioView();
}

// ── Growth Projector ──────────────────────────────────────────────────────────
async function loadProjectorTickers() {
  const sel = document.getElementById('projector-ticker');
  const current = sel.value;
  // Clear and reload every time so newly added stocks appear
  while (sel.options.length > 1) sel.remove(1);
  try {
    const res = await fetch('/api/companies');
    const companies = await res.json();
    companies.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.ticker;
      opt.textContent = `${c.ticker} — ${c.name}`;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  } catch {}
}

let projectorTimeout = null;
function runProjection() {
  clearTimeout(projectorTimeout);
  projectorTimeout = setTimeout(_runProjection, 300);
}

async function _runProjection() {
  const ticker = document.getElementById('projector-ticker').value;
  const years = document.getElementById('projector-years').value;
  if (!ticker) return;

  try {
    const res = await fetch(`/api/project/${ticker}?years=${years}`);
    if (!res.ok) {
      const e = await res.json();
      document.getElementById('projector-placeholder').textContent = `Unable to project ${ticker}: ${e.error}`;
      return;
    }
    const data = await res.json();
    renderProjection(data);
  } catch (e) {
    console.error(e);
  }
}

function renderProjection(data) {
  document.getElementById('projector-output').style.display = 'block';
  document.getElementById('projector-placeholder').style.display = 'none';

  // Summary cards
  const bullFinal = data.projection.bull[data.projection.bull.length - 1];
  const baseFinal = data.projection.base[data.projection.base.length - 1];
  const bearFinal = data.projection.bear[data.projection.bear.length - 1];
  document.getElementById('projection-summary').innerHTML = `
    <div class="scenario-card bull">
      <div class="s-label">🐂 Bull Case</div>
      <div class="s-price">$${bullFinal.toFixed(2)}</div>
      <div class="s-return">+${data.summary.bull}% vs today's $${data.currentPrice.toFixed(2)}</div>
    </div>
    <div class="scenario-card base">
      <div class="s-label">📊 Base Case</div>
      <div class="s-price">$${baseFinal.toFixed(2)}</div>
      <div class="s-return">${data.summary.base >= 0 ? '+' : ''}${data.summary.base}% vs today</div>
    </div>
    <div class="scenario-card bear">
      <div class="s-label">🐻 Bear Case</div>
      <div class="s-price">$${bearFinal.toFixed(2)}</div>
      <div class="s-return">${data.summary.bear >= 0 ? '+' : ''}${data.summary.bear}% vs today</div>
    </div>`;

  document.getElementById('projection-assumptions').innerHTML = `
    <strong>Current revenue growth:</strong> ${(data.revenueGrowthRate * 100).toFixed(1)}%<br>
    <strong>Current P/S ratio:</strong> ${data.psRatio.toFixed(1)}x<br>
    <strong>Bull:</strong> ${data.assumptions.bull}<br>
    <strong>Base:</strong> ${data.assumptions.base}<br>
    <strong>Bear:</strong> ${data.assumptions.bear}`;

  if (projectionChart) { projectionChart.destroy(); projectionChart = null; }
  const el = document.getElementById('projection-chart');
  projectionChart = new Chart(el, {
    type: 'line',
    data: {
      labels: data.projection.labels,
      datasets: [
        { label: 'Bull', data: data.projection.bull, borderColor: '#1a6b4a', backgroundColor: 'rgba(26,107,74,0.08)', borderWidth: 2, pointRadius: 3, fill: false, tension: 0.3 },
        { label: 'Base', data: data.projection.base, borderColor: '#3b7fc4', backgroundColor: 'rgba(59,127,196,0.08)', borderWidth: 2, pointRadius: 3, fill: false, tension: 0.3 },
        { label: 'Bear', data: data.projection.bear, borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.08)', borderWidth: 2, pointRadius: 3, fill: false, tension: 0.3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { font: { size: 12 } } }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: $${ctx.raw.toFixed(2)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 11 }, callback: v => '$' + v.toFixed(0) } }
      }
    }
  });
}

// ── Add Stock ─────────────────────────────────────────────────────────────────
function openAddStock() {
  document.getElementById('add-stock-input').value = '';
  document.getElementById('add-stock-result').textContent = '';
  document.getElementById('add-stock-modal').classList.add('open');
  document.getElementById('add-stock-input').focus();
}

async function addStock() {
  const ticker = document.getElementById('add-stock-input').value.toUpperCase().trim();
  const resultEl = document.getElementById('add-stock-result');
  if (!ticker) { resultEl.innerHTML = '<span style="color:var(--weak)">Enter a ticker symbol.</span>'; return; }

  resultEl.textContent = `Looking up ${ticker}...`;
  try {
    const res = await fetch('/api/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.added === false) {
      resultEl.innerHTML = `<span style="color:var(--muted)">${ticker} is already being tracked.</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:var(--strong)">✓ Added ${data.name} (${data.ticker}). Scoring in background...</span>`;
      setTimeout(() => { closeModal('add-stock-modal'); loadCandidates(); }, 2000);
    }
  } catch (e) {
    resultEl.innerHTML = `<span style="color:var(--weak)">Error: ${e.message}</span>`;
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const btn = document.querySelector('.btn-primary[onclick="refreshAll()"]');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing...'; }
  try {
    await fetch('/api/refresh-all', { method: 'POST' });
    showToast('Refresh started — data updates in ~60 seconds');
    setTimeout(loadCandidates, 65000);
  } catch (e) {
    showToast('Refresh failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh Data'; }
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal('add-stock-modal'); closeModal('add-position-modal'); } });

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtM(v) {
  if (!v) return '—';
  if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toFixed(0)}`;
}

function fmtDollar(v) {
  if (v == null) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseRet(r) { return parseFloat((r || '0').replace(/[%,+]/g, '').trim()) || 0; }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// Enter key support for modals
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (document.getElementById('add-stock-modal').classList.contains('open')) addStock();
    if (document.getElementById('add-position-modal').classList.contains('open')) addPosition();
  }
});
