import { describe, expect, it } from "vitest";
import { mean, nonNull, percentileOf, round, stdev } from "../src/mcp/tools/stats";

describe("nonNull", () => {
  it("filters null, undefined, and NaN", () => {
    expect(nonNull([1, null, 2, undefined, Number.NaN, 3])).toEqual([1, 2, 3]);
  });

  it("returns an empty array when no numbers present", () => {
    expect(nonNull([null, undefined, Number.NaN])).toEqual([]);
  });
});

describe("mean", () => {
  it("computes a simple mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("returns NaN on empty input", () => {
    expect(mean([])).toBeNaN();
  });
});

describe("stdev", () => {
  it("computes sample stdev", () => {
    // [2,4,4,4,5,5,7,9] → mean 5, stdev 2.13809...
    expect(round(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 4)).toBe(2.1381);
  });

  it("returns NaN with fewer than 2 samples", () => {
    expect(stdev([])).toBeNaN();
    expect(stdev([3])).toBeNaN();
  });
});

describe("percentileOf", () => {
  it("returns 0 for values at or below min", () => {
    expect(percentileOf(1, [2, 3, 4, 5])).toBe(0);
    expect(percentileOf(2, [2, 3, 4, 5])).toBe(0);
  });

  it("returns 100 for values at or above max", () => {
    expect(percentileOf(5, [2, 3, 4, 5])).toBe(100);
    expect(percentileOf(99, [2, 3, 4, 5])).toBe(100);
  });

  it("computes interior percentile", () => {
    // value=4 in [2,3,4,5,6] → 2 values below → 40%
    expect(percentileOf(4, [2, 3, 4, 5, 6])).toBe(40);
  });

  it("returns NaN on empty population", () => {
    expect(percentileOf(5, [])).toBeNaN();
  });
});

describe("round", () => {
  it("rounds to N decimals", () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(3.155, 2)).toBe(3.16);
  });

  it("passes through non-finite values", () => {
    expect(round(Number.NaN, 2)).toBeNaN();
    expect(round(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });
});
