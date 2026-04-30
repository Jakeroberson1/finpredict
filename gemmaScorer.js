require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const MODEL = process.env.GEMMA_MODEL || 'gemma-3-27b-it';

function getClient() {
  const key = process.env.GOOGLE_AI_KEY;
  if (!key || key === 'your_google_ai_studio_key_here') {
    throw new Error('GOOGLE_AI_KEY not set in .env — get your free key at https://ai.google.dev');
  }
  return new GoogleGenerativeAI(key).getGenerativeModel({ model: MODEL });
}

const CRITERIA = [
  {
    key: 'tam_large',
    label: 'TAM > $50B',
    prompt: `Does this company operate in a Total Addressable Market greater than $50 billion that is still early-stage and growing? Consider the company's core market AND adjacent expansion opportunities.`,
  },
  {
    key: 'recurring_revenue',
    label: 'Recurring Revenue Model',
    prompt: `Does this company have a strong recurring revenue model? Score 1.0 for clear SaaS subscriptions, razor-and-blade, or contractual ARR. Score 0.5 for partial recurring (e.g., mix of transactional and subscription). Score 0 for purely transactional.`,
  },
  {
    key: 'network_effects',
    label: 'Network Effects / Moat',
    prompt: `Does this company have genuine platform network effects or a deep competitive moat? Score 1.0 for strong compounding network effects (more users = more valuable). Score 0.5 for some moat (data advantage, switching costs, brand). Score 0 for minimal differentiation.`,
  },
  {
    key: 'founder_led',
    label: 'Founder-Led',
    prompt: `Is this company founder-led, or led by someone with a clear long-term 10+ year vision deeply aligned with company mission? Score 1.0 if the original founder is still CEO with significant ownership. Score 0.5 if founder is involved but not CEO, or if a mission-aligned CEO has taken over. Score 0 if professional management with no founder involvement.`,
  },
  {
    key: 'nrr_120',
    label: 'NRR > 120%',
    prompt: `Does this company have Net Revenue Retention (NRR) above 120%? This means existing customers expand their spending by 20%+ per year on average. Score 1.0 if NRR is confirmed above 120%. Score 0.5 if NRR is 110-120% or implied by cohort data. Score 0 if NRR is below 110% or not applicable.`,
  },
  {
    key: 'category_creator',
    label: 'Category Creator',
    prompt: `Is this company creating a fundamentally new product category, or radically disrupting a large existing market in a way that redefines the competitive landscape? Score 1.0 for clear category creation (no prior comparable). Score 0.5 for significant disruption within an existing category. Score 0 for incremental improvement in a crowded market.`,
  },
  {
    key: 'customer_concentration',
    label: 'No Single Customer > 15%',
    prompt: `Is this company free from customer concentration risk? Score 1.0 if no single customer accounts for more than 15% of revenue. Score 0.5 if one customer is 15-25% of revenue. Score 0 if any single customer exceeds 25% of revenue or if the company is heavily dependent on a small number of customers.`,
  },
];

async function scoreCompany(ticker, companyName, context = '') {
  const model = getClient();

  const systemContext = `You are a financial analyst scoring stocks using the Multibagger Prediction Framework.
Company: ${companyName} (${ticker})
${context ? `Recent context: ${context}` : ''}

Score each criterion as 0 (absent), 0.5 (partially present), or 1.0 (strongly present).
Return ONLY a JSON object with this exact structure:
{
  "synopsis": "<2-3 sentence summary: why this stock was selected for analysis, what its key investment thesis is, and what the biggest risk or watch-item is. Be specific, not generic.>",
  "scores": {
    "tam_large": <0|0.5|1>,
    "tam_reasoning": "<one sentence>",
    "recurring_revenue": <0|0.5|1>,
    "recurring_revenue_reasoning": "<one sentence>",
    "network_effects": <0|0.5|1>,
    "network_effects_reasoning": "<one sentence>",
    "founder_led": <0|0.5|1>,
    "founder_led_reasoning": "<one sentence>",
    "nrr_120": <0|0.5|1>,
    "nrr_120_reasoning": "<one sentence>",
    "category_creator": <0|0.5|1>,
    "category_creator_reasoning": "<one sentence>",
    "customer_concentration": <0|0.5|1>,
    "customer_concentration_reasoning": "<one sentence>"
  }
}`;

  const criteriaText = CRITERIA.map(c => `- ${c.label}: ${c.prompt}`).join('\n');

  const prompt = `${systemContext}

Score ${companyName} (${ticker}) on these criteria:
${criteriaText}

Return only the JSON object, no other text.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response (Gemma sometimes wraps in markdown)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Gemma response');

    const parsed = JSON.parse(jsonMatch[0]);
    const scores = parsed.scores || parsed;
    const synopsis = parsed.synopsis || '';

    // Validate and clamp scores to 0/0.5/1
    const validated = { synopsis };
    for (const c of CRITERIA) {
      const raw = scores[c.key];
      const score = [0, 0.5, 1].includes(Number(raw)) ? Number(raw) : 0;
      validated[c.key] = score;
      validated[`${c.key}_reasoning`] = scores[`${c.key}_reasoning`] || '';
    }

    return validated;
  } catch (err) {
    console.error(`Gemma scoring failed for ${ticker}:`, err.message);
    return null;
  }
}

// Score all candidates in sequence to avoid rate limits
async function scoreAllCandidates(companies) {
  const results = {};
  for (const company of companies) {
    console.log(`  Scoring ${company.ticker} qualitatively...`);
    const scores = await scoreCompany(company.ticker, company.name);
    if (scores) results[company.ticker] = scores;
    await new Promise(r => setTimeout(r, 2000)); // 2s between calls for rate limit
  }
  return results;
}

module.exports = { scoreCompany, scoreAllCandidates, CRITERIA };
