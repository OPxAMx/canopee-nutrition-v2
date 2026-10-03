import { describe, expect, it } from "vitest";
import { buildSmartIndicators, type SmartIndicatorTable } from "./smart-indicators";

const table: SmartIndicatorTable = {
  id: "table-1",
  name: "Cycle test",
  weeks: ["Veg 1", "Flo 1"],
  products: [
    { id: "base", name: "Base", color: "#123456", unit: "ml", enabled: true, doses: [1, 2] },
    { id: "disabled", name: "Disabled", color: "#654321", unit: "ml", enabled: false, doses: [1, 2] },
    { id: "zero", name: "Zero", color: "#abcdef", unit: "g", enabled: true, doses: [0, 0] },
  ],
};

describe("buildSmartIndicators", () => {
  it("lists only enabled products with positive doses for the selected week", () => {
    expect(buildSmartIndicators(table, 1, 4)).toEqual([{
      productId: "base",
      productName: "Base",
      color: "#123456",
      unit: "ml",
      dosePerLiter: 2,
      totalDose: 8,
      reason: "Flo 1 · Cycle test",
    }]);
  });

  it("clamps out-of-range week indexes and calculates the requested volume", () => {
    const indicators = buildSmartIndicators(table, 99, 1.5);

    expect(indicators[0]?.dosePerLiter).toBe(2);
    expect(indicators[0]?.totalDose).toBe(3);
  });

  it("returns no indicators when the table has no weeks", () => {
    expect(buildSmartIndicators({ ...table, weeks: [] }, 0, 4)).toEqual([]);
  });
});
