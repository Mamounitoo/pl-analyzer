"use client";

import { useState } from "react";
import { UploadCard } from "@/components/UploadCard";
import { usePlSession } from "@/lib/pl/PlSessionContext";
import { parseSellerboardPnLCsv } from "@/lib/pl/parseSellerboardPnL";
import { buildPlTree } from "@/lib/pl/buildPlTree";
import { formatPct } from "@/lib/pl/format";

const fmtUnits = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const fmtMoneyInt = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function formatMoneyIntUSD(v: number) {
  if (!Number.isFinite(v)) return "";

  const rounded = Math.round(v);
  const abs = Math.abs(rounded);
  const formatted = fmtMoneyInt.format(abs);

  return rounded < 0 ? `-${formatted} $` : `${formatted} $`;
}

function formatUnits(v: number) {
  if (!Number.isFinite(v)) return "";
  return fmtUnits.format(v);
}

function monthAbbrev(m: string) {
  const key = m.trim().toLowerCase();
  const map: Record<string, string> = {
    january: "Jan",
    february: "Feb",
    march: "Mar",
    april: "Apr",
    may: "May",
    june: "Jun",
    july: "Jul",
    august: "Aug",
    september: "Sep",
    october: "Oct",
    november: "Nov",
    december: "Dec",
  };
  return map[key] ?? m;
}

function formatPeriodHeader(
  label: string,
  cadence: string
): { top: string; bottom?: string } {
  const raw = String(label ?? "").trim();

  const wk = raw.match(/^week\s+(\d+)\s*$/i);
  if (wk) return { top: `Wk ${wk[1]}` };

  const range = raw.match(
    /^(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/
  );
  if (range) {
    const d1 = range[1];
    const d2 = range[2];
    const mon = monthAbbrev(range[3]);
    const y = range[4];

    if (cadence === "week") return { top: `${d1}–${d2} ${mon}` };
    return { top: `${d1}–${d2} ${mon}`, bottom: y };
  }

  const monYear = raw.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monYear) {
    const mon = monthAbbrev(monYear[1]);
    const y = monYear[2];
    return { top: mon, bottom: y };
  }

  return { top: raw };
}

// ---------- LW FLAGS (parent buckets only) ----------

type Flag = "good" | "watch" | "bad" | null;

function normLoose(s: unknown) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmtOnePct(x: number) {
  const v = Math.round(x * 1000) / 10; // 1 decimal
  return `${v}%`;
}

type FlagResult = { flag: Flag; hint?: string };

const WATCH_BAND_PTS = 0.01; // 1pp beyond good threshold (per request)

function flagCostPct(lwPct: number, goodMax: number): FlagResult {
  if (!Number.isFinite(lwPct)) return { flag: null };

  const watchMax = goodMax + WATCH_BAND_PTS;

  // Costs show as negative. Compare on magnitude.
  const cost = lwPct < 0 ? -lwPct : 0;

  const hint = `Healthy: ≥ -${fmtOnePct(goodMax)} • Watch: -${fmtOnePct(
    watchMax
  )} to -${fmtOnePct(goodMax)} • Bad: < -${fmtOnePct(watchMax)}`;

  if (cost <= goodMax) return { flag: "good", hint };
  if (cost <= watchMax) return { flag: "watch", hint };
  return { flag: "bad", hint };
}

/**
 * Fixed fees: healthy range -55% to -65% (i.e. cost magnitude 55–65)
 * Watch: 1pp outside either side.
 */
function flagBandCostPct(lwPct: number, goodLo: number, goodHi: number): FlagResult {
  if (!Number.isFinite(lwPct)) return { flag: null };

  const cost = lwPct < 0 ? -lwPct : 0;

  const watchLo = Math.max(0, goodLo - WATCH_BAND_PTS);
  const watchHi = goodHi + WATCH_BAND_PTS;

  const hint = `Healthy: -${fmtOnePct(goodHi)} to -${fmtOnePct(
    goodLo
  )} • Watch: -${fmtOnePct(watchHi)} to -${fmtOnePct(goodHi)} OR -${fmtOnePct(
    goodLo
  )} to -${fmtOnePct(watchLo)} • Bad: outside`;

  if (cost >= goodLo && cost <= goodHi) return { flag: "good", hint };
  if ((cost >= watchLo && cost < goodLo) || (cost > goodHi && cost <= watchHi))
    return { flag: "watch", hint };
  return { flag: "bad", hint };
}

/**
 * Other:
 * - any positive is good
 * - threshold is -1%: good if >= -1%
 * - watch is 1pp below that: [-2%, -1%)
 * - bad < -2%
 */
function flagOtherPct(lwPct: number): FlagResult {
  if (!Number.isFinite(lwPct)) return { flag: null };

  const goodMin = -0.01;
  const watchMin = goodMin - WATCH_BAND_PTS; // -2%

  const hint = `Healthy: ≥ -1.0% (incl. positive) • Watch: -2.0% to -1.0% • Bad: < -2.0%`;

  if (lwPct >= goodMin) return { flag: "good", hint };
  if (lwPct >= watchMin) return { flag: "watch", hint };
  return { flag: "bad", hint };
}

type BucketKind =
  | "fixedFees"
  | "refunds"
  | "promotions"
  | "advertising"
  | "storage"
  | "invAdj"
  | "other";

function detectBucketKind(node: any): BucketKind | null {
  const label = normLoose(node?.label);
  const id = normLoose(node?.id);

  // Exclude margins
  const isMarginLine =
    label.includes("gross margin") || label.startsWith("gm ") || label.startsWith("gm after");
  if (isMarginLine) return null;

  // Exclude "Refunds" lines that are actually units (we also rename in UI)
  if (label === "refunded units" || label.includes("refunded unit")) return null;

  const isFixedFees = label === "fixed fees" || label.includes("fixed fee") || id.includes("fixed");
  if (isFixedFees) return "fixedFees";

  const isRefunds = label === "refunds" || label.includes("refund") || id.includes("refund");
  if (isRefunds) return "refunds";

  const isPromotions =
    label === "promotions" ||
    label.includes("promotion") ||
    label.includes("promo") ||
    id.includes("promo");
  if (isPromotions) return "promotions";

  const isAdvertising =
    label === "advertising" ||
    label.includes("advert") ||
    label.includes("ppc") ||
    label.includes("ads") ||
    id.includes("advert");
  if (isAdvertising) return "advertising";

  const isStorage =
    label.includes("storage") || label.includes("lts") || label.includes("removal") || id.includes("storage");
  if (isStorage) return "storage";

  const isInvAdj =
    label.includes("inventory adjustments") ||
    label.includes("inventory adjustment") ||
    label.includes("inv adj") ||
    id.includes("inventory") ||
    id.includes("inv");
  if (isInvAdj) return "invAdj";

  const isOther = label === "other" || label.startsWith("other ") || id === "other" || id.includes("other");
  if (isOther) return "other";

  return null;
}

function computeBucketFlag(kind: BucketKind, lwPct: number): FlagResult {
  switch (kind) {
    case "fixedFees":
      return flagBandCostPct(lwPct, 0.55, 0.65);
    case "refunds":
      return flagCostPct(lwPct, 0.03);
    case "promotions":
      return flagCostPct(lwPct, 0.03); // promo healthy up to 3%
    case "advertising":
      return flagCostPct(lwPct, 0.05);
    case "storage":
      return flagCostPct(lwPct, 0.02);
    case "invAdj":
      return flagCostPct(lwPct, 0.01);
    case "other":
      return flagOtherPct(lwPct);
    default:
      return { flag: null };
  }
}

export default function PlPage() {
  const { session, setSession } = usePlSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const periods = session.periods ?? [];
  const tree = session.tree ?? [];
  const cadence = session.cadence ?? "period";

  const hasData = periods.length === 4 && tree.length > 0;

  const rangeLabel =
    cadence === "week"
      ? "Last 4 weeks"
      : cadence === "month"
      ? "Last 4 months"
      : "Last 4 periods";

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);

    try {
      const text = await file.text();
      const parsed = parseSellerboardPnLCsv(text);
      const built = buildPlTree(parsed);

      const buildCollapsedMap = (nodes: any[]) => {
        const map: Record<string, boolean> = {};
        const walk = (n: any) => {
          if (Array.isArray(n.children) && n.children.length > 0) map[n.id] = true;
          (n.children ?? []).forEach(walk);
        };
        nodes.forEach(walk);
        return map;
      };
      setCollapsed(buildCollapsedMap(built as any[]));

      setSession({
        fileName: file.name,
        periods: parsed.periods,
        cadence: parsed.cadence,
        revenue: parsed.revenue,
        tree: built,
      });
    } catch (e: any) {
      setError(e?.message ?? "Failed to parse file");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? true) }));
  }

  const COL_LINE_W = 180;
  const COL_W = 60;
  const COL_BENCH_W = 110;

  // Sellerboard periods are displayed newest -> oldest, so latest period is index 0
  const LAST_WEEK_INDEX = 0;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold">P&amp;L Analyzer</div>
        </div>

        {hasData ? (
          <button
            className="rounded-xl border px-3 py-2 text-sm font-medium hover:bg-gray-50"
            onClick={() => setSession({})}
          >
            Upload another file
          </button>
        ) : null}
      </div>

      {!hasData ? (
        <UploadCard
          title="Upload Sellerboard P&L"
          subtitle="CSV only • Monthly/Weekly • Brand or ASIN level"
          busy={busy}
          error={error}
          onFiles={onFiles}
        />
      ) : (
        <div className="rounded-2xl border bg-white shadow-sm">
          <div className="border-b p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-semibold">{rangeLabel} P&L</div>
              </div>
            </div>
          </div>

          <div className="p-5 overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: COL_LINE_W }} />
                {periods.map((p) => (
                  <col key={p.key} style={{ width: COL_W }} />
                ))}
                {periods.map((p) => (
                  <col key={p.key + "_pct"} style={{ width: COL_W }} />
                ))}
                <col style={{ width: COL_BENCH_W }} />
              </colgroup>

              <thead className="sticky top-0 z-20 bg-white">
                <tr className="border-b">
                  <th
                    className="py-1.5 pr-2 text-left font-semibold sticky left-0 z-30 bg-white"
                    style={{ width: COL_LINE_W }}
                  >
                    Line
                  </th>

                  {periods.map((p) => {
                    const h = formatPeriodHeader(p.label, cadence);
                    return (
                      <th
                        key={p.key}
                        className="py-1.5 px-2 text-right font-semibold whitespace-normal leading-tight"
                      >
                        <div>{h.top}</div>
                        {h.bottom ? <div className="text-xs text-gray-500">{h.bottom}</div> : null}
                      </th>
                    );
                  })}

                  {periods.map((p) => (
                    <th
                      key={p.key + "_pct"}
                      className="py-1.5 px-2 text-right font-semibold text-gray-500 whitespace-normal leading-tight"
                    >
                      %
                    </th>
                  ))}

                  <th className="py-1.5 px-2 text-left font-semibold">LW Flags</th>
                </tr>
              </thead>

              <tbody>
                {tree.map((node) => (
                  <Row
                    key={node.id}
                    node={node}
                    level={0}
                    parentIsBucket={false}
                    collapsed={collapsed}
                    onToggle={toggle}
                    lastWeekIndex={LAST_WEEK_INDEX}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  node,
  level,
  parentIsBucket,
  collapsed,
  onToggle,
  lastWeekIndex,
}: {
  node: any;
  level: number;
  parentIsBucket: boolean;
  collapsed: Record<string, boolean>;
  onToggle: (id: string) => void;
  lastWeekIndex: number;
}) {
  const pad = level === 0 ? "pl-0" : level === 1 ? "pl-6" : "pl-10";
  const isGroup = Array.isArray(node.children) && node.children.length > 0;
  const isCollapsed = isGroup ? (collapsed[node.id] ?? true) : false;

  const isUnitsRow =
    typeof node.id === "string" && (node.id === "units" || node.id.startsWith("units_"));

  const isUnitSessionPctRow =
    typeof node.id === "string" && node.id === "unit_session_pct";

  const isAspRow = node.id === "asp";

  const fmtMoney2 = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  function formatMoney2USD(v: number) {
    if (!Number.isFinite(v)) return "";
    const abs = Math.abs(v);
    const formatted = fmtMoney2.format(abs);
    return v < 0 ? `-${formatted} $` : `${formatted} $`;
  }

  const isSessionsRow =
    typeof node.id === "string" &&
    (node.id === "sessions" || node.id.startsWith("sessions_"));

  const isNonCurrencyValueRow = isUnitsRow || isSessionsRow;

  const isRevenueTop = level === 0 && node.id === "revenue";
  const isAspTop = level === 0 && node.id === "asp";

  // Rename the units-level "Refunds" line to avoid confusion + prevent flag matching.
  const labelNorm = normLoose(node?.label);
  const displayLabel =
    isNonCurrencyValueRow && labelNorm === "refunds" ? "Refunded units" : node.label;

  const lwPct = Array.isArray(node.pct) ? node.pct[lastWeekIndex] : NaN;

  // 1) Do NOT show flags on children of a bucket (sub-costs).
  // Also: never flag non-currency rows (units/sessions).
  const kind = !parentIsBucket && !isNonCurrencyValueRow ? detectBucketKind({ ...node, label: displayLabel }) : null;
  const res = kind ? computeBucketFlag(kind, lwPct) : { flag: null as Flag };

  const badge =
    res.flag === "good"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : res.flag === "watch"
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : res.flag === "bad"
      ? "bg-red-50 text-red-800 border-red-200"
      : "bg-gray-50 text-gray-700 border-gray-200";

  const thisIsBucket = kind !== null;

  return (
    <>
      <tr className={node.kind === "subtotal" || isRevenueTop ? "border-b bg-gray-50/50" : "border-b"}>
        <td
          className={`py-1.5 pr-2 ${pad} sticky left-0 z-10 bg-white ${
            node.kind === "subtotal" || isRevenueTop ? "bg-gray-50/50" : ""
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {isGroup ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(node.id);
                }}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs hover:bg-gray-50"
                aria-label={isCollapsed ? "Expand" : "Collapse"}
              >
                {isCollapsed ? "+" : "–"}
              </button>
            ) : (
              <span className="inline-block h-6 w-6 shrink-0" />
            )}

            <div
              className={`min-w-0 truncate ${
                node.kind === "subtotal" || isRevenueTop || isAspTop
                  ? "font-semibold"
                  : isGroup
                  ? "font-medium"
                  : ""
              }`}
              title={displayLabel}
            >
              {displayLabel}
            </div>
          </div>
        </td>

        {node.values.map((v: number, i: number) => (
          <td
            key={i}
            className={`py-1.5 px-2 text-right tabular-nums ${
              node.kind === "subtotal" || isRevenueTop || isAspTop ? "font-semibold" : ""
            }`}
          >
            {Number.isFinite(v)
              ? isUnitSessionPctRow
                ? `${v.toFixed(2)}%`
                : isNonCurrencyValueRow
                ? formatUnits(v)
                : isAspRow
                ? formatMoney2USD(v)
                : formatMoneyIntUSD(v)
              : ""}
          </td>
        ))}

        {node.pct.map((p: number, i: number) => (
          <td
            key={i}
            className={`py-1.5 px-2 text-right tabular-nums ${
              node.kind === "subtotal" || isRevenueTop || isAspTop
                ? "font-semibold text-gray-700"
                : "text-gray-500"
            }`}
          >
            {Number.isFinite(p) ? formatPct(p) : "—"}
          </td>
        ))}

        <td className="py-1.5 px-2">
          {res.flag ? (
            <span
              title={res.hint}
              className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${badge}`}
            >
              {res.flag}
            </span>
          ) : null}
        </td>
      </tr>

      {!isCollapsed &&
        (node.children ?? []).map((c: any) => (
          <Row
            key={c.id}
            node={c}
            level={level + 1}
            parentIsBucket={parentIsBucket || thisIsBucket}
            collapsed={collapsed}
            onToggle={onToggle}
            lastWeekIndex={lastWeekIndex}
          />
        ))}
    </>
  );
}