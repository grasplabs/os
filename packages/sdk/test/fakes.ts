import { createTestEngine } from "../src/testing.ts";
import type { TestEngineOptions } from "../src/testing.ts";

/** A test engine that runs the steps that change something, against fakes. */
export const createFakeEngine = (options: TestEngineOptions = {}) =>
  createTestEngine({ sideEffects: "run", ...options });

/** An invoice as the sample invoice workflow takes it. */
export const invoice = {
  number: "INV-7",
  purchaseOrder: "PO-1",
  text: "Total €8,000",
};
