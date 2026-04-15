/**
 * Human-friendly label formatting.
 * Converts raw field names like "gross_revenue" → "Gross Revenue".
 * Preserves known acronyms. Supports manual overrides.
 */

// ── Acronyms to keep uppercase ───────────────────────────

const ACRONYMS = new Set([
  "roas", "roi", "nps", "sku", "cpc", "cpm", "ctr", "aov",
  "ltv", "clv", "arpu", "mrr", "arr", "gmv", "kpi", "yoy",
  "qoq", "mom", "ebitda", "cogs", "id", "url", "api", "csv",
  "pdf", "pct", "avg", "qty",
]);

// ── Manual overrides for specific field names ────────────

const OVERRIDES: Record<string, string> = {
  gross_revenue: "Gross Revenue",
  net_revenue: "Net Revenue",
  gross_profit: "Gross Profit",
  net_profit: "Net Profit",
  gross_margin_pct: "Gross Margin %",
  net_margin_pct: "Net Margin %",
  units_sold: "Units Sold",
  unit_price: "Unit Price",
  return_rate: "Return Rate",
  conversion_rate: "Conversion Rate",
  discount_pct: "Discount %",
  discount_amount: "Discount Amount",
  ad_spend_allocated: "Ad Spend",
  average_selling_price: "Avg Selling Price",
  site_sessions: "Site Sessions",
  shipping_revenue: "Shipping Revenue",
  holiday_period_flag: "Holiday Period",
  fiscal_year: "Fiscal Year",
  product_category: "Product Category",
  campaign_name: "Campaign Name",
  customer_name: "Customer Name",
  order_date: "Order Date",
  sale_date: "Sale Date",
  cost_of_goods: "Cost of Goods",
};

// ── Core formatter ───────────────────────────────────────

export function formatLabel(raw: string): string {
  if (!raw) return "";

  const lower = raw.toLowerCase().trim();

  // Check manual overrides first
  if (OVERRIDES[lower]) return OVERRIDES[lower];

  // Split on underscores, hyphens, camelCase boundaries
  const words = lower
    .replace(/([a-z])([A-Z])/g, "$1_$2") // camelCase → underscore
    .split(/[_\-\s]+/)
    .filter(Boolean);

  // Capitalize each word, preserving acronyms
  return words
    .map((w) => {
      if (ACRONYMS.has(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/**
 * Format a numeric value for display in KPI cards.
 * Rounds large numbers: 1234567 → "1.23M", 45678 → "45.7K"
 */
export function formatKpiValue(n: number, decimals = 1): string {
  if (n == null || isNaN(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(decimals)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(decimals)}K`;
  if (n % 1 !== 0) return n.toFixed(decimals);
  return n.toLocaleString();
}

/**
 * Format a percentage delta for KPI cards.
 * Returns "+12.3%" or "-5.1%" with sign.
 */
export function formatDelta(pct: number): string {
  if (pct == null || isNaN(pct)) return "";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
