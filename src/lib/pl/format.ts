export function formatMoney(v: number) {
    const sign = v < 0 ? "-" : "";
    const abs = Math.abs(v);
    return `${sign}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  
  export function formatPct(p: number) {
    if (!isFinite(p)) return "—";
    return `${(p * 100).toFixed(1)}%`;
  }