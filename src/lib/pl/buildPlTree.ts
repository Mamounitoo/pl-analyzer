import type { ParsedPnL, RawLine } from "@/lib/pl/parseSellerboardPnL";
import type { PlNode } from "@/lib/pl/PlSessionContext";
import { Bench } from "@/lib/pl/benchmarks";

function norm(s: unknown) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const ZEROS = [0, 0, 0, 0];
const BLANKS = [NaN, NaN, NaN, NaN];

function sum4(lines: RawLine[]) {
  const out = [0, 0, 0, 0];
  for (const l of lines) for (let i = 0; i < 4; i++) out[i] += l.values[i] ?? 0;
  return out;
}

function pctOfRevenue(values: number[], revenue: number[]) {
  return values.map((v, i) => (revenue[i] ? v / revenue[i] : NaN));
}

function abs4(values: number[]) {
  return values.map((v) => Math.abs(v ?? 0));
}

function int4(values: unknown) {
  const arr = Array.isArray(values) ? (values as any[]) : ZEROS;
  return [0, 1, 2, 3].map((i) => {
    const n = Number(arr[i] ?? 0);
    return Number.isFinite(n) ? Math.round(n) : 0;
  });
}

function statusFor(type: "grossMargin" | "refunds" | "promo" | "ads" | "storage", p: number) {
  const b: any = Bench[type];

  if (type === "grossMargin") {
    if (p < b.badBelow) return "bad";
    if (p < b.watchBelow) return "watch";
    return "good";
  }

  const mag = Math.abs(p);
  if (mag > b.badAbove) return "bad";
  if (mag > b.watchAbove) return "watch";
  return "good";
}

function flagsFor(type: "grossMargin" | "refunds" | "promo" | "ads" | "storage", p: number) {
  const s = statusFor(type, p);
  if (s === "good") return [];

  if (type === "grossMargin") return s === "bad" ? ["gross margin too low"] : ["gross margin low"];
  if (type === "refunds") return s === "bad" ? ["refunds too high"] : ["refunds high"];
  if (type === "promo") return s === "bad" ? ["promo too heavy"] : ["promo high"];
  if (type === "ads") return s === "bad" ? ["ads too heavy"] : ["ads high"];
  if (type === "storage") return s === "bad" ? ["storage too high"] : ["storage high"];
  return [];
}

type BucketId = "pricing" | "refunds" | "promo" | "ads" | "storage" | "inventory" | "other";

type Rule =
  | { action: "ignore" }
  | { action: "bucket"; bucket: BucketId; subgroup?: "cogs" | "amazon_fees" | "other_costs" };

const RULES: Record<string, Rule> = Object.fromEntries(
  [
    // ---- ignore aggregate / computed / not needed rows ----
    ["advertising cost", { action: "ignore" }],
    ["shipping costs", { action: "ignore" }],
    ["amazon fees", { action: "ignore" }],
    ["cost of goods", { action: "ignore" }],
    ["vat", { action: "ignore" }], // handled separately via VAT logic
    ["gross profit", { action: "ignore" }],
    ["net profit", { action: "ignore" }],
    ["estimated payout", { action: "ignore" }],
    ["% refunds", { action: "ignore" }],
    ["sellable returns", { action: "ignore" }],
    ["margin", { action: "ignore" }],
    ["roi", { action: "ignore" }],
    ["real acos", { action: "ignore" }],

    // ---- IMPORTANT: prevent Sessions / traffic metrics from leaking into Other ----
    ["sessions", { action: "ignore" }],
    ["browser sessions", { action: "ignore" }],
    ["mobile app sessions", { action: "ignore" }],
    ["unit session percentage", { action: "ignore" }],
    ["active subscriptions (sns)", { action: "ignore" }],

    // ---- IMPORTANT: prevent Units metric "Refunds" from leaking into Other costs ----
    ["refunds", { action: "ignore" }],

    // ---- pricing: COGS (single line) ----
    ["cost of goods sold", { action: "bucket", bucket: "pricing", subgroup: "cogs" }],

    // ---- pricing: fixed amazon fees ----
    ["referral fee", { action: "bucket", bucket: "pricing", subgroup: "amazon_fees" }],
    ["fba per unit fulfilment fee", { action: "bucket", bucket: "pricing", subgroup: "amazon_fees" }],
    ["digital services fee", { action: "bucket", bucket: "pricing", subgroup: "amazon_fees" }],
    ["digital services fee fba", { action: "bucket", bucket: "pricing", subgroup: "amazon_fees" }],
    // Disambiguated form: "Digital services fee" when indented under "Refund cost" in the CSV
    ["digital services fee (refund cost)", { action: "bucket", bucket: "refunds" }],
    ["fba fee (mcf)", { action: "bucket", bucket: "other" }],
    ["multi-channel", { action: "bucket", bucket: "other" }],

    // ---- storage ----
    ["fba storage fee", { action: "bucket", bucket: "storage" }],
    ["long term storage fee", { action: "bucket", bucket: "storage" }],
    ["storage disposal fee", { action: "bucket", bucket: "storage" }],
    ["fba disposal fee", { action: "bucket", bucket: "storage" }],

    // ---- promotions (Coup/Deal/Vine) ----
    ["promo", { action: "bucket", bucket: "promo" }],
    ["promotion", { action: "bucket", bucket: "promo" }],
    ["lightning deal fee", { action: "bucket", bucket: "promo" }],
    ["deal performance fee rollup", { action: "bucket", bucket: "promo" }],
    ["deal performance fee", { action: "bucket", bucket: "promo" }],
    ["deal participation fee rollup", { action: "bucket", bucket: "promo" }],
    ["deal participation fee", { action: "bucket", bucket: "promo" }],
    ["coupon redemption fee", { action: "bucket", bucket: "promo" }],
    ["coupon performance fee", { action: "bucket", bucket: "promo" }],
    ["coupon participation fee", { action: "bucket", bucket: "promo" }],
    ["vine fee", { action: "bucket", bucket: "promo" }],
    ["vine enrollment fee", { action: "bucket", bucket: "promo" }],

    // ---- advertising ----
    ["sponsored products", { action: "bucket", bucket: "ads" }],
    ["sponsored brands", { action: "bucket", bucket: "ads" }],
    ["sponsored display", { action: "bucket", bucket: "ads" }],
    ["sponsored television", { action: "bucket", bucket: "ads" }],
    ["sponsored brands video", { action: "bucket", bucket: "ads" }],

    // ---- inventory adjustments ----
    ["disposal of sellable products", { action: "bucket", bucket: "inventory" }],
    ["lost/damaged by amazon", { action: "bucket", bucket: "inventory" }],
    ["missing from inbound", { action: "bucket", bucket: "inventory" }],
    ["missing from inbound clawback", { action: "bucket", bucket: "inventory" }],
    ["warehouse damage", { action: "bucket", bucket: "inventory" }],
    ["warehouse lost", { action: "bucket", bucket: "inventory" }],
    ["reversal reimbursement", { action: "bucket", bucket: "inventory" }],
    ["missing returns", { action: "bucket", bucket: "inventory" }],
    ["compensated clawback", { action: "bucket", bucket: "inventory" }],
    ["liquidations brokerage fee", { action: "bucket", bucket: "inventory" }],
    ["liquidations revenue", { action: "bucket", bucket: "inventory" }],

    // ---- other costs ----
    ["indirect expenses", { action: "bucket", bucket: "other" }],
    ["subscription", { action: "bucket", bucket: "other" }],
    ["giftwrap", { action: "bucket", bucket: "other" }],
    ["fba shipping chargeback", { action: "bucket", bucket: "other" }],
  ].map(([k, v]) => [norm(k), v as Rule])
);

function isIndented(name: string) {
  return /^\s+/.test(name ?? "");
}

/**
 * Extracts a top-level block and its indented children, removing them from remaining lines.
 */
function extractTopLevelBlock(
  all: RawLine[],
  topLevelName: string
): { root: RawLine | null; children: RawLine[]; remaining: RawLine[] } {
  const target = norm(topLevelName);
  const remaining: RawLine[] = [];
  let root: RawLine | null = null;
  const children: RawLine[] = [];

  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    const top = !isIndented(l.name);
    if (!root && top && norm(l.name) === target) {
      root = l;

      for (let j = i + 1; j < all.length; j++) {
        const n = all[j];
        if (!isIndented(n.name)) {
          i = j - 1;
          break;
        }
        children.push(n);
        i = j;
      }
      continue;
    }
    remaining.push(l);
  }

  return { root, children, remaining };
}

function findAny(children: RawLine[], patterns: RegExp[]) {
  const c = children.find((x) => patterns.some((r) => r.test(norm(x.name))));
  return c ?? null;
}

function pickOrganic(children: RawLine[]) {
  return findAny(children, [/^organic$/]);
}

function pickSponsored(children: RawLine[], kind: "products" | "brands" | "display") {
  if (kind === "products") return findAny(children, [/sponsored.*product/, /sponsored product/]);
  if (kind === "brands") return findAny(children, [/sponsored.*brand/, /sponsored.*brands/, /sponsored brand/]);
  return findAny(children, [/sponsored.*display/, /sponsored display/]);
}

function pickDirectSales(children: RawLine[]) {
  return findAny(children, [/direct.*sales/, /^direct$/]);
}

function pickSubscriptionSales(children: RawLine[]) {
  return findAny(children, [/subscription.*sales/, /subscribe.*sales/, /^subscription$/]);
}

function pickDirectUnits(children: RawLine[]) {
  return findAny(children, [/direct.*unit/, /direct units/, /^direct$/]);
}

function pickRefundUnits(children: RawLine[]) {
  return findAny(children, [/^refunds$/]);
}

function pickSubscriptionUnits(children: RawLine[]) {
  return findAny(children, [/subscription.*unit/, /subscribe.*unit/, /subscription units/, /^subscription$/]);
}

function applyBench(
  tree: PlNode[],
  label: string,
  type: "grossMargin" | "refunds" | "promo" | "ads" | "storage",
  pctArr: number[]
) {
  const n = tree.find((x) => x.label === label);
  if (!n) return;
  const p = pctArr[3];
  n.status = statusFor(type, p);
  n.flags = flagsFor(type, p);
}

function costGroup(id: string, label: string, lines: RawLine[], revenue: number[]): PlNode {
  const total = sum4(lines);
  return {
    id,
    label,
    kind: "line",
    values: total,
    pct: pctOfRevenue(total, revenue),
    children: lines.map((l, idx) => ({
      id: `${id}_${idx}`,
      label: l.name,
      kind: "line",
      values: l.values,
      pct: pctOfRevenue(l.values, revenue),
    })),
  };
}

function subtotal(id: string, label: string, values: number[], pct: number[]): PlNode {
  return { id, label, kind: "subtotal", values, pct };
}

/**
 * Refund block extraction:
 * - Anchors on "Refund cost"
 * - Captures a contiguous allow-list block
 * - Ignores the "Refund cost" parent row
 * - Removes BOTH the parent row and captured children from remaining
 */
function extractRefundCostBlock(all: RawLine[]) {
  const anchor = "refund cost";
  const allow = new Set(
    [
      "refund cost",
      "refunded referral fee",
      "value of returned items",
      "promotion",
      "fba shipping chargeback",
      "ship promotion",
      "digital services fee (refund cost)",
      "gift wrap chargeback",
      "taxdiscount",
      "shippingtaxdiscount",
      "gift wrap tax",
      "shipping tax",
      "gift wrap",
      "refunded shipping",
      "refund commission",
      "goodwillprincipal",
      "refunded amount",
    ].map(norm)
  );

  const idx = all.findIndex((l) => norm(l.name) === anchor);
  if (idx < 0) {
    return { refundLines: [] as RawLine[], remaining: all };
  }

  const refundLines: RawLine[] = [];
  const removed: RawLine[] = [];

  let i = idx;
  while (i < all.length) {
    const n = norm(all[i].name);
    if (!allow.has(n)) break;

    removed.push(all[i]); // remove everything in the block (including parent)
    if (n !== "refund cost") refundLines.push(all[i]); // exclude parent aggregate
    i++;
  }

  const removedSet = new Set(removed);
  const remaining = all.filter((l) => !removedSet.has(l));

  return { refundLines, remaining };
}

function dropAggregateVatLine(vatLines: RawLine[]) {
  if (vatLines.length < 3) return vatLines;

  const absSumOthers = (idx: number) => {
    const out = [0, 0, 0, 0];
    for (let i = 0; i < vatLines.length; i++) {
      if (i === idx) continue;
      const v = abs4(vatLines[i].values);
      for (let k = 0; k < 4; k++) out[k] += v[k] ?? 0;
    }
    return out;
  };

  const approxEq = (a: number[], b: number[], tol = 0.01) =>
    a.every((av, i) => Math.abs((av ?? 0) - (b[i] ?? 0)) <= tol);

  const candidates = vatLines
    .map((l, idx) => ({ l, idx }))
    .filter(({ l }) => norm(l.name) === "vat" && !isIndented(l.name));

  for (const c of candidates) {
    const cand = abs4(c.l.values);
    const others = absSumOthers(c.idx);
    if (approxEq(cand, others)) {
      return vatLines.filter((_, i) => i !== c.idx);
    }
  }

  for (let i = 0; i < vatLines.length; i++) {
    const cand = abs4(vatLines[i].values);
    const others = absSumOthers(i);
    if (approxEq(cand, others)) {
      return vatLines.filter((_, j) => j !== i);
    }
  }

  return vatLines;
}

function buildVatNode(vatLines: RawLine[], netRevenue: number[]): PlNode {
  const filtered = dropAggregateVatLine(vatLines);
  const totalRaw = sum4(filtered);
  const total = abs4(totalRaw);

  return {
    id: "vat",
    label: "VAT",
    kind: "line",
    values: total,
    pct: pctOfRevenue(total, netRevenue),
    children: filtered.map((l, idx) => ({
      id: `vat_${idx}`,
      label: l.name,
      kind: "line",
      values: abs4(l.values),
      pct: pctOfRevenue(abs4(l.values), netRevenue),
    })),
  };
}

function buildGrossRevenueNode(grossRevenue: number[], netRevenue: number[], vatNode: PlNode): PlNode {
  return {
    id: "gross_revenue",
    label: "Gross Revenue",
    kind: "line",
    values: grossRevenue,
    pct: BLANKS,
    children: [
      {
        id: "gross_revenue_net",
        label: "Net Revenue",
        kind: "line",
        values: netRevenue,
        pct: pctOfRevenue(netRevenue, netRevenue),
      },
      vatNode,
    ],
  };
}

function scale4(values: number[], factors: number[]) {
  return values.map((v, i) => (Number.isFinite(v) ? v * (factors[i] ?? 0) : 0));
}

function buildRevenueNode(netRevenue: number[], salesChildrenGross: RawLine[], grossRevenue: number[]): PlNode {
  // We only have a gross breakdown in Sellerboard.
  // To keep children summing to Net Revenue, scale each child by (net/gross) per period.
  const factors = grossRevenue.map((g, i) => {
    const gg = g ?? 0;
    const nn = netRevenue[i] ?? 0;
    return gg ? nn / gg : 0;
  });

  const organic = pickOrganic(salesChildrenGross);
  const sp = pickSponsored(salesChildrenGross, "products");
  const sb = pickSponsored(salesChildrenGross, "brands");
  const sd = pickSponsored(salesChildrenGross, "display");

  const direct = pickDirectSales(salesChildrenGross);
  const subscription = pickSubscriptionSales(salesChildrenGross);

  const pctRev = pctOfRevenue(netRevenue, netRevenue);

  const orgPaidBucket: PlNode = {
    id: "rev_org_paid_bucket",
    label: "Organic / Paid",
    kind: "line",
    values: BLANKS,
    pct: BLANKS,
    children: [
      {
        id: "rev_organic",
        label: "Organic",
        kind: "line",
        values: organic ? scale4(organic.values, factors) : ZEROS,
        pct: organic ? pctOfRevenue(scale4(organic.values, factors), netRevenue) : pctOfRevenue(ZEROS, netRevenue),
      },
      {
        id: "rev_sp",
        label: "Sponsored Products",
        kind: "line",
        values: sp ? scale4(sp.values, factors) : ZEROS,
        pct: sp ? pctOfRevenue(scale4(sp.values, factors), netRevenue) : pctOfRevenue(ZEROS, netRevenue),
      },
      {
        id: "rev_sb",
        label: "Sponsored Brands",
        kind: "line",
        values: sb ? scale4(sb.values, factors) : ZEROS,
        pct: sb ? pctOfRevenue(scale4(sb.values, factors), netRevenue) : pctOfRevenue(ZEROS, netRevenue),
      },
      {
        id: "rev_sd",
        label: "Sponsored Display",
        kind: "line",
        values: sd ? scale4(sd.values, factors) : ZEROS,
        pct: sd ? pctOfRevenue(scale4(sd.values, factors), netRevenue) : pctOfRevenue(ZEROS, netRevenue),
      },
    ],
  };

  const dirSubBucket: PlNode = {
    id: "rev_dir_sub_bucket",
    label: "Direct / Subscription",
    kind: "line",
    values: BLANKS,
    pct: BLANKS,
    children: [
      {
        id: "rev_direct",
        label: "Direct",
        kind: "line",
        values: direct ? scale4(direct.values, factors) : ZEROS,
        pct: direct ? pctOfRevenue(scale4(direct.values, factors), netRevenue) : pctOfRevenue(ZEROS, netRevenue),
      },
      {
        id: "rev_subscription",
        label: "Subscription",
        kind: "line",
        values: subscription ? scale4(subscription.values, factors) : ZEROS,
        pct: subscription
          ? pctOfRevenue(scale4(subscription.values, factors), netRevenue)
          : pctOfRevenue(ZEROS, netRevenue),
      },
    ],
  };

  return {
    id: "revenue",
    label: "Net Revenue",
    kind: "line",
    values: netRevenue,
    pct: pctRev,
    children: [orgPaidBucket, dirSubBucket],
  };
}

function buildSessionsNode(parsed: ParsedPnL): PlNode | null {
  const s = (parsed as any).sessions;
  if (!s) return null;

  return {
    id: "sessions",
    label: "Sessions",
    kind: "line",
    values: s.total,
    pct: BLANKS,
    children: [
      {
        id: "sessions_browser",
        label: "Browser Sessions",
        kind: "line",
        values: s.browser ?? ZEROS,
        pct: BLANKS,
      },
      {
        id: "sessions_mobile",
        label: "Mobile App Sessions",
        kind: "line",
        values: s.mobile ?? ZEROS,
        pct: BLANKS,
      },
      // last + integer values
      {
        id: "sessions_active_subs",
        label: "Active subscriptions (SnS)",
        kind: "line",
        values: int4(s.activeSubs),
        pct: BLANKS,
      },
    ],
  };
}

function buildUspNode(parsed: ParsedPnL): PlNode | null {
  const s = (parsed as any).sessions;
  if (!s?.unitSessionPct) return null;
  return {
    id: "unit_session_pct",
    label: "Unit Session %",
    kind: "line",
    values: s.unitSessionPct,
    pct: BLANKS,
  };
}

function buildUnitsNode(
  unitsRoot: RawLine | null,
  unitsChildren: RawLine[],
  refundsUnitsLine: RawLine | null
): PlNode | null {
  if (!unitsRoot) return null;

  const organic = pickOrganic(unitsChildren);
  const sp = pickSponsored(unitsChildren, "products");
  const sb = pickSponsored(unitsChildren, "brands");
  const sd = pickSponsored(unitsChildren, "display");

  const direct = pickDirectUnits(unitsChildren);
  const subscription = pickSubscriptionUnits(unitsChildren);

  const denom = unitsRoot.values;
  const pctOfUnits = (values: number[]) => values.map((v, i) => (denom[i] ? v / denom[i] : NaN));

  const orgPaidBucket: PlNode = {
    id: "units_org_paid_bucket",
    label: "Organic / Paid",
    kind: "line",
    values: BLANKS,
    pct: BLANKS,
    children: [
      {
        id: "units_organic",
        label: "Organic",
        kind: "line",
        values: organic ? organic.values : ZEROS,
        pct: pctOfUnits(organic ? organic.values : ZEROS),
      },
      {
        id: "units_sp",
        label: "Sponsored Products",
        kind: "line",
        values: sp ? sp.values : ZEROS,
        pct: pctOfUnits(sp ? sp.values : ZEROS),
      },
      {
        id: "units_sb",
        label: "Sponsored Brands",
        kind: "line",
        values: sb ? sb.values : ZEROS,
        pct: pctOfUnits(sb ? sb.values : ZEROS),
      },
      {
        id: "units_sd",
        label: "Sponsored Display",
        kind: "line",
        values: sd ? sd.values : ZEROS,
        pct: pctOfUnits(sd ? sd.values : ZEROS),
      },
    ],
  };

  const dirSubBucket: PlNode = {
    id: "units_dir_sub_bucket",
    label: "Direct / Subscription",
    kind: "line",
    values: BLANKS,
    pct: BLANKS,
    children: [
      {
        id: "units_direct",
        label: "Direct",
        kind: "line",
        values: direct ? direct.values : ZEROS,
        pct: pctOfUnits(direct ? direct.values : ZEROS),
      },
      {
        id: "units_subscription",
        label: "Subscription",
        kind: "line",
        values: subscription ? subscription.values : ZEROS,
        pct: pctOfUnits(subscription ? subscription.values : ZEROS),
      },
    ],
  };

  const refundsValues = refundsUnitsLine ? refundsUnitsLine.values : ZEROS;

  const refundsNode: PlNode = {
    id: "units_refunds",
    label: "Refunds",
    kind: "line",
    values: refundsValues,
    pct: pctOfUnits(refundsValues),
  };

  return {
    id: "units",
    label: "Units",
    kind: "line",
    values: denom,
    pct: BLANKS,
    children: [orgPaidBucket, dirSubBucket, refundsNode],
  };
}

function buildAspNode(grossRevenue: number[], unitsRoot: RawLine | null): PlNode | null {
  if (!unitsRoot) return null;

  const asp = grossRevenue.map((r, i) => {
    const u = unitsRoot.values[i] ?? 0;
    return u ? r / u : 0;
  });

  return { id: "asp", label: "ASP", kind: "line", values: asp, pct: BLANKS };
}

export function buildPlTree(parsed: ParsedPnL): PlNode[] {
  // Sales + Units blocks
  const { children: salesChildren, remaining: afterSales } = extractTopLevelBlock(parsed.lines, "sales");
  const { root: unitsRoot, children: unitsChildren, remaining } = extractTopLevelBlock(afterSales, "units");

  // Sellerboard Sales = GROSS revenue
  const grossRevenue = parsed.revenue;

  // VAT lines removed from costs
  const vatLines = remaining.filter((l) => norm(l.name).includes("vat"));
  const remainingNoVat = remaining.filter((l) => !norm(l.name).includes("vat"));

  // Build VAT values first (pct will be computed once we have net revenue)
  // buildVatNode needs netRevenue denominator, but netRevenue depends on VAT totals.
  const vatNodeTmp = buildVatNode(vatLines, grossRevenue); // temporary denom; we'll fix pct after netRevenue exists
  const vatTotal = vatNodeTmp.values;

  // NET = GROSS - VAT
  const netRevenue = grossRevenue.map((g, i) => (g ?? 0) - (vatTotal[i] ?? 0));

  // Rebuild VAT node with correct denom (net revenue)
  const vatNode = buildVatNode(vatLines, netRevenue);

  // Gross Revenue node: Gross -> (Net + VAT)
  const grossRevenueNode = buildGrossRevenueNode(grossRevenue, netRevenue, vatNode);

  // Refund block extraction (removes parent + children from remaining)
  const { refundLines, remaining: remainingNoVatNoRefunds } = extractRefundCostBlock(remainingNoVat);

  const sessionsNode = buildSessionsNode(parsed);
  const uspNode = buildUspNode(parsed);

  // Buckets
  const byBucket: Record<BucketId, RawLine[]> = {
    pricing: [],
    refunds: [],
    promo: [],
    ads: [],
    storage: [],
    inventory: [],
    other: [],
  };

  // Refunds are only the extracted refund block
  byBucket.refunds = refundLines;

  // Route everything else via rules (unknown -> other)
  for (const l of remainingNoVatNoRefunds) {
    const key = norm(l.name);
    const rule = RULES[key];

    if (rule?.action === "ignore") continue;

    const bucket = rule?.action === "bucket" ? rule.bucket : "other";
    byBucket[bucket].push(l);
  }

  // Pricing and margin waterfall (anchor on NET revenue)
  const pricingCosts = sum4(byBucket.pricing);
  const grossMargin = netRevenue.map((v, i) => (v ?? 0) + (pricingCosts[i] ?? 0));

  const refundTotal = sum4(byBucket.refunds);
  const gmAfterRefunds = grossMargin.map((v, i) => (v ?? 0) + (refundTotal[i] ?? 0));

  const promoTotal = sum4(byBucket.promo);
  const gmAfterPromo = gmAfterRefunds.map((v, i) => (v ?? 0) + (promoTotal[i] ?? 0));

  const adsTotal = sum4(byBucket.ads);
  const gmAfterAds = gmAfterPromo.map((v, i) => (v ?? 0) + (adsTotal[i] ?? 0));

  const storageTotal = sum4(byBucket.storage);
  const gmAfterStorage = gmAfterAds.map((v, i) => (v ?? 0) + (storageTotal[i] ?? 0));

  const invTotal = sum4(byBucket.inventory);
  const gmAfterInv = gmAfterStorage.map((v, i) => (v ?? 0) + (invTotal[i] ?? 0));

  const grossPct = pctOfRevenue(grossMargin, netRevenue);
  const refundsPct = pctOfRevenue(refundTotal, netRevenue);
  const promoPct = pctOfRevenue(promoTotal, netRevenue);
  const adsPct = pctOfRevenue(adsTotal, netRevenue);
  const storagePct = pctOfRevenue(storageTotal, netRevenue);

  const otherTotal = sum4(byBucket.other);
  const otherPct = pctOfRevenue(otherTotal, netRevenue);

  // Net Margin = after inventory + other (unmapped)
  const netMargin = gmAfterInv.map((v, i) => (v ?? 0) + (otherTotal[i] ?? 0));
  const netMarginPct = pctOfRevenue(netMargin, netRevenue);

  // Revenue node (Net) with scaled children (so sums match)
  const revenueNode = buildRevenueNode(netRevenue, salesChildren, grossRevenue);

  // Units + ASP
  const refundsUnitsLine =
    pickRefundUnits(unitsChildren) ?? parsed.lines.find((l) => norm(l.name) === "refunds") ?? null;

  const unitsNode = buildUnitsNode(unitsRoot, unitsChildren, refundsUnitsLine);

  // ASP should be based on GROSS revenue (unit price paid incl VAT)
  const aspNode = buildAspNode(grossRevenue, unitsRoot);

  // Pricing children: COGS single line + Amazon Fees (everything else in pricing)
  const cogsLine = byBucket.pricing.find((l) => norm(l.name) === "cost of goods sold") ?? null;
  const amazonFeesLines = byBucket.pricing.filter((l) => norm(l.name) !== "cost of goods sold");

  const pricingNode: PlNode = {
    id: "pricing",
    label: "Fixed fees",
    kind: "line",
    values: sum4(byBucket.pricing),
    pct: pctOfRevenue(sum4(byBucket.pricing), netRevenue),
    children: [
      {
        id: "pricing_cogs",
        label: "Cost of goods sold",
        kind: "line",
        values: cogsLine ? cogsLine.values : ZEROS,
        pct: pctOfRevenue(cogsLine ? cogsLine.values : ZEROS, netRevenue),
      },
      {
        id: "pricing_fees",
        label: "Amazon Fees",
        kind: "line",
        values: sum4(amazonFeesLines),
        pct: pctOfRevenue(sum4(amazonFeesLines), netRevenue),
        children: amazonFeesLines.map((l, idx) => ({
          id: `pricing_fee_${idx}`,
          label: l.name,
          kind: "line",
          values: l.values,
          pct: pctOfRevenue(l.values, netRevenue),
        })),
      },
    ],
  };

  const tree: PlNode[] = [
    ...(sessionsNode ? [sessionsNode] : []),
    ...(uspNode ? [uspNode] : []),

    grossRevenueNode,
    revenueNode,

    ...(unitsNode ? [unitsNode] : []),
    ...(aspNode ? [aspNode] : []),

    pricingNode,
    subtotal("gm", "Gross Margin", grossMargin, grossPct),

    costGroup("refunds", "Refunds", byBucket.refunds, netRevenue),
    subtotal("gm_ref", "GM after Refunds", gmAfterRefunds, pctOfRevenue(gmAfterRefunds, netRevenue)),

    costGroup("promo", "Promotions", byBucket.promo, netRevenue),
    subtotal("gm_promo", "GM after Promo", gmAfterPromo, pctOfRevenue(gmAfterPromo, netRevenue)),

    costGroup("ads", "Advertising", byBucket.ads, netRevenue),
    subtotal("gm_ads", "GM after Adv.", gmAfterAds, pctOfRevenue(gmAfterAds, netRevenue)),

    costGroup("storage", "Storage / LTS / removals", byBucket.storage, netRevenue),
    subtotal("gm_storage", "GM after Str.", gmAfterStorage, pctOfRevenue(gmAfterStorage, netRevenue)),

    costGroup("inventory", "Inventory Adjustments", byBucket.inventory, netRevenue),
    subtotal("gm_inventory", "GM after Inv. Adj.", gmAfterInv, pctOfRevenue(gmAfterInv, netRevenue)),

    {
      id: "other",
      label: "Other",
      kind: "line",
      values: otherTotal,
      pct: otherPct,
      children: byBucket.other.map((l, idx) => ({
        id: `other_${idx}`,
        label: l.name,
        kind: "line",
        values: l.values,
        pct: pctOfRevenue(l.values, netRevenue),
      })),
    },

    subtotal("net_margin", "Net Margin", netMargin, netMarginPct),
  ];

  // Benchmarks (based on NET revenue anchor)
  applyBench(tree, "Gross Margin", "grossMargin", grossPct);
  applyBench(tree, "Refunds", "refunds", refundsPct);
  applyBench(tree, "Promotions (Coup/Deal/Vine)", "promo", promoPct);
  applyBench(tree, "Advertising", "ads", adsPct);
  applyBench(tree, "Storage / LTS / removals", "storage", storagePct);

  const otherNode = tree.find((x) => x.id === "other");
  if (otherNode) {
    const p = Math.abs(otherPct[3] ?? 0);
    if (p >= 0.01) {
      otherNode.status = p >= 0.03 ? "bad" : "watch";
      otherNode.flags = [p >= 0.03 ? "too much unmapped cost" : "some unmapped lines"];
    }
  }

  return tree;
}