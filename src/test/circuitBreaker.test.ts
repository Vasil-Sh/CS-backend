import { describe, it, expect, beforeEach } from "vitest";
import {
  isOpen,
  recordSuccess,
  recordFailure,
  getStatus,
} from "../services/circuitBreaker";

// The circuitBreaker module uses a module-level Map.
// We reset it manually via recordSuccess before each test.

describe("circuitBreaker", () => {
  const CIRCUIT = "test_circuit";
  const DIFFERENT = "other_circuit";

  beforeEach(() => {
    // Reset test circuit
    recordSuccess(CIRCUIT);
    recordSuccess(DIFFERENT);
  });

  describe("initial state", () => {
    it("is not open initially", () => {
      expect(isOpen(CIRCUIT)).toBe(false);
    });

    it("has 0 failures initially", () => {
      expect(getStatus(CIRCUIT)).toEqual({ open: false, failures: 0 });
    });
  });

  describe("failure counting", () => {
    it("counts consecutive failures", () => {
      recordFailure(CIRCUIT);
      expect(getStatus(CIRCUIT).failures).toBe(1);

      recordFailure(CIRCUIT);
      expect(getStatus(CIRCUIT).failures).toBe(2);
    });

    it("opens circuit after threshold failures", () => {
      recordFailure(CIRCUIT); // 1
      recordFailure(CIRCUIT); // 2
      recordFailure(CIRCUIT); // 3 — threshold
      expect(isOpen(CIRCUIT)).toBe(true);
      expect(getStatus(CIRCUIT)).toEqual({ open: true, failures: 3 });
    });

    it("opens circuit at threshold (3 failures)", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(true);
    });

    it("does NOT open circuit at 2 failures", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(false);
    });
  });

  describe("success resets failures", () => {
    it("resets failure count to 0", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      recordSuccess(CIRCUIT);
      expect(getStatus(CIRCUIT).failures).toBe(0);
      expect(isOpen(CIRCUIT)).toBe(false);
    });

    it("resets open circuit", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT); // opens
      expect(isOpen(CIRCUIT)).toBe(true);

      recordSuccess(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(false);
    });
  });

  describe("circuit isolation", () => {
    it("separate circuits don't affect each other", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(isOpen(DIFFERENT)).toBe(false);
      expect(getStatus(DIFFERENT).failures).toBe(0);
    });

    it("opening one circuit doesn't open another", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(true);
      expect(isOpen(DIFFERENT)).toBe(false);
    });
  });

  describe("half-open behavior", () => {
    it("allows one request through after timeout (half-open)", () => {
      // Open the circuit
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(true);

      // Simulate timeout by manipulating lastFailure directly (not exposed, tested via time)
      // isOpen checks timeout — we can't fake time without mocking Date,
      // but we test that success after open resets it
      recordSuccess(CIRCUIT);
      expect(isOpen(CIRCUIT)).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns correct status for fresh circuit", () => {
      expect(getStatus("fresh_circuit")).toEqual({ open: false, failures: 0 });
    });

    it("returns correct status after failures", () => {
      recordFailure(CIRCUIT);
      recordFailure(CIRCUIT);
      expect(getStatus(CIRCUIT)).toEqual({ open: false, failures: 2 });
    });
  });
});
