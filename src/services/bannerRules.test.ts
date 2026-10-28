import { describe, it, expect } from "vitest";
import { validPlacement, periodsOverlap } from "./bannerRules";
describe("banner scheduling rules", () => {
  it("accepts all five screens and open-ended campaigns", () => {
    for (const screen of [
      "matches",
      "journal",
      "analytics",
      "strategies",
      "risky-teams",
    ])
      expect(
        validPlacement({ screen, slot: 2, startsOn: null, endsOn: null }),
      ).toBe(true);
  });
  it("rejects invalid dates, periods, screens, slots and malformed bodies", () => {
    for (const body of [
      null,
      [],
      { startsOn: "2026-02-30" },
      { endsOn: "" },
      { startsOn: "2026-10-29", endsOn: "2026-10-28" },
      { screen: "unknown" },
      { slot: 3 },
      { active: "yes" },
    ])
      expect(validPlacement(body)).toBe(false);
  });
  it("treats the last day as inclusive", () => {
    expect(
      periodsOverlap({ endsOn: "2026-10-28" }, { startsOn: "2026-10-28" }),
    ).toBe(true);
    expect(
      periodsOverlap({ endsOn: "2026-10-28" }, { startsOn: "2026-10-29" }),
    ).toBe(false);
  });
  it("detects contained and unlimited periods", () => {
    expect(
      periodsOverlap({}, { startsOn: "2026-10-28", endsOn: "2026-10-29" }),
    ).toBe(true);
    expect(
      periodsOverlap(
        { startsOn: "2026-10-01", endsOn: "2026-10-31" },
        { startsOn: "2026-10-10", endsOn: "2026-10-12" },
      ),
    ).toBe(true);
  });
});
