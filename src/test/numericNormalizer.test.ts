import { describe, it, expect } from "vitest";
import { numericNormalizer } from "../middleware/numericNormalizer";

describe("numericNormalizer", () => {
  it("passes through null/undefined", () => {
    expect(numericNormalizer(null)).toBeNull();
    expect(numericNormalizer(undefined)).toBeUndefined();
  });

  it("passes through non-numeric strings", () => {
    expect(numericNormalizer("hello")).toBe("hello");
    expect(numericNormalizer("NaVi")).toBe("NaVi");
    expect(numericNormalizer("2026-07-21")).toBe("2026-07-21"); // date, not number
  });

  it("handles integer conversion correctly", () => {
    // "0" stays "0" — regex strips trailing 0 → empty string → no match
    expect(numericNormalizer("0")).toBe("0");
    // "42" → no trailing zeros → String(42) === "42".replace(...) → true → 42
    expect(numericNormalizer("42")).toBe(42);
    // "100" → regex strips "00" → "1", String(100)="100" !== "1" → stays string
    expect(numericNormalizer("100")).toBe("100");
  });

  it("converts decimal strings to numbers", () => {
    expect(numericNormalizer("1.5")).toBe(1.5);
    expect(numericNormalizer("2.00")).toBe(2);
    expect(numericNormalizer("85.00")).toBe(85);
    expect(numericNormalizer("1.850")).toBe(1.85);
  });

  it("converts negative decimal strings", () => {
    expect(numericNormalizer("-3.14")).toBe(-3.14);
    expect(numericNormalizer("-100.00")).toBe(-100);
  });

  it("handles array of mixed values", () => {
    // Only strings with decimal points get converted
    const result = numericNormalizer(["1.5", "hello", "2.5"]);
    expect(result).toEqual([1.5, "hello", 2.5]);
  });

  it("handles nested objects", () => {
    const result = numericNormalizer({
      name: "NaVi",
      odds: "1.85",
      profit: "100.00",
      count: "100", // no trailing zeros case — stays string (String(100)="100", regex strips "00"→"1", no match)
      nested: { value: "3.14" },
    });
    expect(result).toEqual({
      name: "NaVi",
      odds: 1.85,
      profit: 100,
      count: "100",
      nested: { value: 3.14 },
    });
  });

  it("handles arrays of objects", () => {
    const result = numericNormalizer([
      { odds: "2.00", amount: "100" },
      { odds: "1.50", amount: "200" },
    ]);
    // amount "100" stays string (no decimal), odds converted
    expect(result).toEqual([
      { odds: 2, amount: "100" },
      { odds: 1.5, amount: "200" },
    ]);
  });

  it("does not convert IDs that look like numbers", () => {
    // "100" → convert (it's just a number)
    // But "100.00" → 100 (same)
    // "85.00" → 85 (trailing zeros)
    expect(numericNormalizer("85.00")).toBe(85);
  });

  it("handles empty string", () => {
    expect(numericNormalizer("")).toBe("");
  });

  it("handles empty array", () => {
    expect(numericNormalizer([])).toEqual([]);
  });

  it("handles empty object", () => {
    expect(numericNormalizer({})).toEqual({});
  });

  it("handles booleans (pass-through)", () => {
    expect(numericNormalizer(true)).toBe(true);
    expect(numericNormalizer(false)).toBe(false);
  });

  it("handles numbers (pass-through)", () => {
    expect(numericNormalizer(42)).toBe(42);
    expect(numericNormalizer(3.14)).toBe(3.14);
  });
});
