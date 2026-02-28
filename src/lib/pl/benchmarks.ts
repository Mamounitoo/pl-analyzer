export const Bench = {
    grossMargin: { watchBelow: 0.35, badBelow: 0.30 },
    refunds: { watchAbove: 0.05, badAbove: 0.08 },      // as % of revenue (cost is negative)
    promo: { watchAbove: 0.10, badAbove: 0.15 },
    ads: { watchAbove: 0.12, badAbove: 0.18 },
    storage: { watchAbove: 0.03, badAbove: 0.05 },
  } as const;