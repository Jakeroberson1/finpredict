require('dotenv').config();
const db = require('./db');
const { scoreAll, getSeedQualitative } = require('./scorer');

const CANDIDATES = [
  {
    ticker: 'DUOL', name: 'Duolingo', sector: 'Technology',
    seed_tier: 'Elite', seed_score: 12.0, flagged: 0, flagged_reason: null,
    synopsis: 'Duolingo is selected for its rare combination of a founder with 35% ownership, 72% gross margins, a $400M active buyback, and zero customer concentration. The investment thesis is a global language learning platform with 50M daily active users monetizing through subscriptions — the TAM is $115B+ and digital penetration is still early. Key watch item: a deliberate DAU growth slowdown in 2026 is creating a contrarian entry point, but needs to show return to accelerating paid subscriber growth.'
  },
  {
    ticker: 'NET', name: 'Cloudflare', sector: 'Technology',
    seed_tier: 'Elite', seed_score: 12.0, flagged: 0, flagged_reason: null,
    synopsis: 'Cloudflare is selected as the best pure-play on AI internet infrastructure: it handles 50%+ of global API traffic and already routes 80% of the top AI-native companies. The investment thesis is that as AI models proliferate, every inference call flows through Cloudflare\'s network, creating a deepening moat with each new customer. Key watch item: valuation at 35x P/S is aggressive — for a 10x return from $76B market cap, it would need to reach $760B, which requires becoming the definitive AI networking layer globally.'
  },
  {
    ticker: 'APP', name: 'AppLovin', sector: 'Technology',
    seed_tier: 'Elite', seed_score: 12.0, flagged: 0, flagged_reason: null,
    synopsis: 'AppLovin is selected for extraordinary financial metrics: 84% EBITDA margin, $3.95B FCF growing 88% YoY, and an AI engine (Axon 2.0) that creates a compounding data moat in mobile advertising. The investment thesis is that its AI ad optimization engine improves with scale, making AppLovin increasingly hard to displace as the default performance advertising layer for mobile apps. Key watch item: 704 insider share sales with zero purchases in 6 months, and a $150B market cap requiring $1.5T for a 10x — both are meaningful headwinds.'
  },
  {
    ticker: 'AXON', name: 'Axon Enterprise', sector: 'Technology',
    seed_tier: 'Elite', seed_score: 11.0, flagged: 0, flagged_reason: null,
    synopsis: 'Axon Enterprise is selected as the operating system for public safety — body cameras, digital evidence, records management, and real-time operations — with no real competitor at scale. The investment thesis is a $14.4B contracted backlog, NRR of 125%, and multi-decade runway as it expands internationally and into new government verticals. Key watch item: concentration in US law enforcement creates single-sector dependency, and government procurement cycles make revenue lumpy quarter-to-quarter.'
  },
  {
    ticker: 'IOT', name: 'Samsara', sector: 'Technology',
    seed_tier: 'Strong', seed_score: 10.5, flagged: 0, flagged_reason: null,
    synopsis: 'Samsara is selected as the ServiceNow for the physical economy — connecting vehicles, equipment, and workers into a single IoT/AI platform across logistics, construction, energy, and government. The investment thesis is a $100B+ TAM that is 10-15 years behind software digitization, with ARR growing 30%+ and NRR above 115%. Key watch item: hardware component pulls blended gross margins to 68% vs pure-SaaS peers, and the company needs to demonstrate sustained FCF expansion.'
  },
  {
    ticker: 'MELI', name: 'MercadoLibre', sector: 'Consumer',
    seed_tier: 'Strong', seed_score: 10.0, flagged: 0, flagged_reason: null,
    synopsis: 'MercadoLibre is selected as Amazon + PayPal for Latin America, with 83M active buyers, $277B in payment volume, and 45% YoY revenue growth. The investment thesis is that Latin America\'s digital economy is 10-15 years behind the US, giving MercadoLibre a massive structural tailwind as its vertically integrated ecosystem (e-commerce, payments, logistics, credit) compounds. Key watch item: LatAm currency risk (especially Argentina/Brazil) adds significant volatility, and a $82B market cap limits the math for a 10x return.'
  },
  {
    ticker: 'TOST', name: 'Toast', sector: 'Technology',
    seed_tier: 'Strong', seed_score: 9.0, flagged: 1,
    flagged_reason: 'Toast IPO\'d at $40 in September 2021 and is still trading ~35% below its IPO price nearly 5 years later — the market pre-priced years of growth that hasn\'t materialized. More critically, 82% of revenue comes from payments processing (not software), creating a structural gross margin ceiling at ~26% that prevents it from achieving the software-like economics this framework requires. NRR is not reported in standard SaaS format, making it impossible to verify revenue retention quality. The business fundamentals are real (revenue 9x since 2019, FCF positive), but it is structurally mismatched to the multibagger framework.',
    synopsis: 'Toast is flagged despite a 9/15 score because of two structural issues: its IPO-price underperformance (still below $40 IPO price from 2021) and a gross margin ceiling at ~26% caused by payments-dominated revenue. The investment thesis as a tech-enabled restaurant platform is sound — revenue grew 9x since 2019 — but its economics look more like a fintech processor than a software company. Watch for: gross margin expansion toward 35-40% as software subscriptions grow relative to payments, which would be the trigger to reconsider for high-conviction status.'
  },
  {
    ticker: 'CRDO', name: 'Credo Technology', sector: 'Technology',
    seed_tier: 'Speculative', seed_score: 8.5, flagged: 0, flagged_reason: null,
    synopsis: 'Credo Technology is selected as a picks-and-shovels play on AI infrastructure: its active electrical cables (AECs) and SerDes IP connect GPUs in AI training clusters, making it a critical but often overlooked component of the AI buildout. The investment thesis is 201% YoY revenue growth and rapidly expanding gross margins as AI data center buildout accelerates. Key risk: severe customer concentration with a majority of revenue from 2-3 hyperscaler customers — if one switches to internal chip design, Credo loses a disproportionate share of revenue overnight.'
  },
  {
    ticker: 'RXRX', name: 'Recursion Pharma', sector: 'Healthcare',
    seed_tier: 'Speculative', seed_score: 7.5, flagged: 0, flagged_reason: null,
    synopsis: 'Recursion Pharma is selected as the highest-optionality play in AI drug discovery: its platform has generated 50+ petabytes of proprietary biological data and has multiple clinical-stage programs. The investment thesis is binary — if their AI-discovered compounds produce one approved drug, the stock could 10x from $3B; if not, the loss is total. Key consideration: this is a pre-revenue drug company where traditional financial metrics don\'t apply — the score reflects platform quality and category creation, not current profitability.'
  },
  {
    ticker: 'JOBY', name: 'Joby Aviation', sector: 'Industrials',
    seed_tier: 'Speculative', seed_score: 7.0, flagged: 0, flagged_reason: null,
    synopsis: 'Joby Aviation is selected as the category creator in urban air mobility — electric vertical takeoff vehicles for city transportation. The investment thesis is a legitimate new transportation mode with FAA certification pathway underway, a Uber partnership for distribution, and $700M+ from Toyota providing manufacturing credibility and capital. Key risk: pre-revenue with significant regulatory and manufacturing execution risk; commercial operations may not begin at scale until 2027-2028 at the earliest.'
  },
  {
    ticker: 'BROS', name: 'Dutch Bros', sector: 'Consumer',
    seed_tier: 'Weak', seed_score: 6.5, flagged: 0, flagged_reason: null,
    synopsis: 'Dutch Bros is included in the watchlist as a consumer brand compounder, but it scores poorly against the multibagger framework because its economics are those of a restaurant chain, not a platform. Gross margins at ~25% are structurally below the 50% threshold, there is no recurring revenue model, and the founder sold $300M in shares recently — significant alignment concern. The Dutch Rewards loyalty program (60%+ attachment) and 4,000+ location expansion plan are genuine strengths, but this framework targets software-like economics.'
  },
  {
    ticker: 'RKLB', name: 'Rocket Lab', sector: 'Industrials',
    seed_tier: 'Weak', seed_score: 6.5, flagged: 0, flagged_reason: null,
    synopsis: 'Rocket Lab is included as the strongest small satellite launch provider outside SpaceX, with a category-creating position in dedicated small payload launches. However, it scores poorly due to $1.75B in equity issuance over 18 months (massive dilution), CEO insider ownership of only 0.71%, and CEO selling $143M with zero purchases — the exact pattern the framework is designed to avoid. The TAM is real and enormous, but per-share compounding is being destroyed by dilution.'
  },
];

const HISTORICAL = [
  { ticker: 'NVDA', name: 'NVIDIA', sector: 'Technology', seed_score: 7.5, peak_return: '22,500%', growth_window: '2015–2025' },
  { ticker: 'TSLA', name: 'Tesla', sector: 'Consumer', seed_score: 6.5, peak_return: '13,198%', growth_window: '2012–2021' },
  { ticker: 'NFLX', name: 'Netflix', sector: 'Consumer', seed_score: 7.5, peak_return: '8,000%', growth_window: '2009–2018' },
  { ticker: 'MNST', name: 'Monster Beverage', sector: 'Consumer', seed_score: 4.5, peak_return: '7,500%', growth_window: '2003–2012' },
  { ticker: 'AMZN', name: 'Amazon', sector: 'Technology', seed_score: 7.5, peak_return: '4,900%', growth_window: '2009–2018' },
  { ticker: 'SHOP', name: 'Shopify', sector: 'Technology', seed_score: 8.5, peak_return: '4,477%', growth_window: '2015–2021' },
  { ticker: 'ISRG', name: 'Intuitive Surgical', sector: 'Healthcare', seed_score: 7.0, peak_return: '4,000%', growth_window: '2004–2014' },
  { ticker: 'BKNG', name: 'Booking Holdings', sector: 'Consumer', seed_score: 6.5, peak_return: '3,000%', growth_window: '2009–2019' },
  { ticker: 'DPZ', name: "Domino's Pizza", sector: 'Consumer', seed_score: 4.5, peak_return: '2,547%', growth_window: '2011–2021' },
  { ticker: 'NOW', name: 'ServiceNow', sector: 'Technology', seed_score: 7.0, peak_return: '2,500%', growth_window: '2012–2022' },
  { ticker: 'AAPL', name: 'Apple', sector: 'Technology', seed_score: 7.0, peak_return: '2,000%', growth_window: '1997–2007' },
  { ticker: 'GOOGL', name: 'Google/Alphabet', sector: 'Technology', seed_score: 8.5, peak_return: '1,800%', growth_window: '2004–2014' },
  { ticker: 'META', name: 'Meta/Facebook', sector: 'Technology', seed_score: 7.0, peak_return: '1,428%', growth_window: '2012–2019' },
  { ticker: 'MSFT', name: 'Microsoft', sector: 'Technology', seed_score: 7.0, peak_return: '1,247%', growth_window: '2012–2021' },
  { ticker: 'CRM', name: 'Salesforce', sector: 'Technology', seed_score: 7.5, peak_return: '1,200%', growth_window: '2004–2014' },
];

async function seed() {
  console.log('Seeding companies...');

  for (const c of CANDIDATES) {
    db.upsertCompany({ ...c, category: 'candidate' });
  }
  for (const h of HISTORICAL) {
    db.upsertCompany({ ...h, category: 'historical', flagged: 0, flagged_reason: null });
  }

  console.log(`Inserted ${CANDIDATES.length} candidates + ${HISTORICAL.length} historical`);

  // Seed qualitative scores
  console.log('Seeding qualitative scores...');
  const today = new Date().toISOString().slice(0, 10);
  for (const c of CANDIDATES) {
    const qual = getSeedQualitative(c.ticker);
    db.upsertQualitativeScores(c.ticker, today, qual);
  }

  // Initial quantitative scoring
  console.log('Scoring all candidates from FMP...');
  await scoreAll(false);

  // Create default portfolio
  db.getOrCreateDefaultPortfolio();
  console.log('\nSeed complete. Run "npm start" to launch.');
}

seed().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
