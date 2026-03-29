import type { PlPeriod } from "@/lib/pl/PlSessionContext";

export type RawLine = { name: string; values: number[] };

export type ParsedPnL = {
  periods: PlPeriod[];
  revenue: number[];
  lines: RawLine[];
  cadence: "week" | "month" | "period";
  sessions?: {
    total: number[];
    browser?: number[];
    mobile?: number[];
    unitSessionPct?: number[];
    activeSubs?: number[];
  };
};

function norm(s: string) {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function firstByNormName(lines: RawLine[]) {
  const map = new Map<string, RawLine>();
  for (const l of lines) {
    const k = norm(l.name);
    if (!map.has(k)) map.set(k, l);
  }
  return map;
}

function pickByAliases(map: Map<string, RawLine>, aliases: string[]) {
  for (const a of aliases) {
    const hit = map.get(norm(a));
    if (hit) return hit;
  }
  return null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"') {
      const next = text[i + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && (c === "," || c === ";")) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += c;
  }

  row.push(cell);
  // Preserve leading whitespace in the label column (col 0) so we can detect
  // indentation/parent-context later; trim everything else normally.
  rows.push(row.map((x, i) => (i === 0 ? x.trimEnd() : x.trim())));
  return rows.filter((r) => r.some((x) => x.trim().length > 0));
}

function toNum(s: string) {
  const raw = (s ?? "").trim();
  if (!raw) return 0;

  // ✅ Percent cells like "16.42%" (Sellerboard already gives % values)
  if (raw.includes("%")) {
    const cleanedPct = raw
      .replace(/\s/g, "")
      .replace(/\(([^)]+)\)/, "-$1")
      .replace(/%/g, "")
      .replace(/,/g, ""); // just in case
    const v = Number(cleanedPct);
    return isFinite(v) ? v : 0;
  }

  const cleaned = raw
    .replace(/\s/g, "")
    .replace(/\(([^)]+)\)/, "-$1")
    .replace(/[$€£]/g, "");

  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;

  // decimal comma
  if (hasComma && !hasDot) normalized = cleaned.replace(",", ".");
  // remove thousand separators like 1,234.56
  normalized = normalized.replace(/,(?=\d{3}(\D|$))/g, "");

  const v = Number(normalized);
  return isFinite(v) ? v : 0;
}

function isTotalHeader(h: string) {
  const n = norm(h);
  return n === "total" || n.includes("total");
}

function detectCadence(periodLabels: string[]): "week" | "month" | "period" {
  const labels = (periodLabels ?? []).map((s) => String(s ?? "").trim());

  const monthName =
    /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

  // "January 2026", "November 2025" (monthly columns)
  const monthHeader = new RegExp(
    `^\\s*(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\\s+\\d{4}\\s*$`,
    "i"
  );

  // Weekly date-range labels typically start with a day: "1-7 February 2026", "23-24 February 2026"
  const startsWithDayRange = /^\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/;

  const joined = norm(labels.join(" "));

  // Month wins if we see any pure month header
  if (labels.some((l) => monthHeader.test(l))) return "month";

  // Week keywords / codes
  if (/\b(week|wk)\b/i.test(joined) || /\bw\d{1,2}\b/i.test(joined)) return "week";

  // Otherwise: if all labels are "day-range + month name", it's weekly-style
  const hasDayRange = labels.some((l) => startsWithDayRange.test(l));
  const hasMonthWord = labels.some((l) => monthName.test(l));
  if (hasDayRange && hasMonthWord) return "week";

  // Fallback: month if month words exist and we don't see week patterns
  if (hasMonthWord) return "month";

  return "period";
}

export function parseSellerboardPnLCsv(text: string): ParsedPnL {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV looks empty");

  const header = rows[0];
  const periodHeadersAll = header.slice(1).filter(Boolean);
  if (periodHeadersAll.length < 1) throw new Error("Could not detect period columns");

  // Drop trailing Total column(s) if present
  let periodHeaders = [...periodHeadersAll];
  while (periodHeaders.length > 1 && isTotalHeader(periodHeaders[periodHeaders.length - 1])) {
    periodHeaders.pop();
  }

  if (periodHeaders.length < 1) throw new Error("Not enough non-Total periods found");

  // Sellerboard newest periods are on the LEFT in your file; keep all of them
  const kept = periodHeaders;
  const cadence = detectCadence(kept.slice(0, 4));

  const periods: PlPeriod[] = kept.map((label, i) => ({
    key: `p${i}`,
    label,
  }));

  const keepStart = periodHeadersAll.indexOf(kept[0]);
  if (keepStart < 0) throw new Error("Internal: could not align period columns");

  const lines: RawLine[] = [];
  let currentParent = "";
  for (const r of rows.slice(1)) {
    const rawName = r[0];
    if (!rawName?.trim()) continue;

    const indented = /^\s/.test(rawName);
    const trimmedName = rawName.trim();
    const normalizedName = norm(trimmedName);

    // Track the nearest non-indented row as the current parent section header.
    if (!indented) currentParent = normalizedName;

    // Preserve leading whitespace in the stored name so isIndented() in buildPlTree.ts
    // can correctly identify indented children of "Sales" and "Units" blocks.
    // Only override the name for explicit disambiguation cases.
    let effectiveName = rawName;
    if (normalizedName === "digital services fee" && currentParent === "refund cost") {
      effectiveName = "digital services fee (refund cost)";
    }

    const valsAll = r.slice(1).map((x) => (x ?? "").trim());
    const vals = valsAll.slice(keepStart, keepStart + kept.length).map(toNum);
    lines.push({ name: effectiveName, values: vals });
  }

  // Revenue detection
  const revenueCandidates = ["sales", "revenue", "product sales", "gross sales"];
  const revLine =
    lines.find((l) => revenueCandidates.includes(norm(l.name))) ??
    // Fallback: avoid picking breakdown lines like "Direct sales"
    lines.find((l) => {
      const n = norm(l.name);
      return n.includes("sales") && !n.includes("direct") && !n.includes("subscription");
    }) ??
    null;

  if (!revLine) throw new Error("Could not find Revenue/Sales line in file");

  // Sessions (robust to indentation / ordering)
  const byName = firstByNormName(lines);
  
  const sessionsTotal = pickByAliases(byName, ["Sessions"]);
  const browserSessions = pickByAliases(byName, ["Browser sessions", "Browser Sessions"]);
  const mobileSessions = pickByAliases(byName, ["Mobile app sessions", "Mobile App Sessions"]);
  const unitSessionPct = pickByAliases(byName, ["Unit session percentage", "Unit Session Percentage"]);
  
// Sessions metrics (top-level in Sellerboard exports)
const pick = (label: string) => lines.find((l) => norm(l.name) === norm(label)) ?? null;

const sessionsLine = pick("Sessions");
const browserLine = pick("Browser sessions");
const mobileLine = pick("Mobile app sessions");
const uspLine = pick("Unit session percentage");
const activeSubsLine = pick("Active subscriptions (SnS)");

const sessions =
  sessionsLine
    ? {
        total: sessionsLine.values,
        browser: browserLine?.values,
        mobile: mobileLine?.values,
        unitSessionPct: uspLine?.values,
        activeSubs: activeSubsLine?.values,
      }
    : undefined;
  
  return {
    periods,
    cadence,
    revenue: revLine.values,
    lines,
    sessions,
  };
}