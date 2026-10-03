export type SmartIndicatorProduct = {
  id: string;
  name: string;
  color: string;
  unit: "ml" | "g";
  enabled: boolean;
  doses: number[];
};

export type SmartIndicatorTable = {
  id: string;
  name: string;
  weeks: string[];
  products: SmartIndicatorProduct[];
};

export type SmartIndicator = {
  productId: string;
  productName: string;
  color: string;
  unit: "ml" | "g";
  dosePerLiter: number;
  totalDose: number;
  reason: string;
};

export function buildSmartIndicators(
  table: SmartIndicatorTable,
  weekIndex: number,
  liters: number,
): SmartIndicator[] {
  if (!table.weeks.length || !Number.isFinite(weekIndex)) return [];

  const selectedWeekIndex = Math.min(
    Math.max(0, Math.floor(weekIndex)),
    table.weeks.length - 1,
  );
  const week = table.weeks[selectedWeekIndex];
  const volume = Number.isFinite(liters) && liters > 0 ? liters : 0;

  return table.products.flatMap((product) => {
    const dosePerLiter = product.doses[selectedWeekIndex];
    if (!product.enabled || !Number.isFinite(dosePerLiter) || dosePerLiter <= 0) return [];

    return [{
      productId: product.id,
      productName: product.name,
      color: product.color,
      unit: product.unit,
      dosePerLiter,
      totalDose: dosePerLiter * volume,
      reason: `${week} · ${table.name}`,
    }];
  });
}
