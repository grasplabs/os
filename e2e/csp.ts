import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    /** Exposed by Playwright to the page, see below. */
    reportCspViolation: (violation: string) => Promise<void>;
  }
}

/**
 * Collects every Content Security Policy violation on `page`, from the
 * `securitypolicyviolation` event and from the browser's console. The event
 * reaches the document only from elements in it; the console reports more.
 */
export const recordCspViolations = async (page: Page): Promise<string[]> => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content[ -]security[ -]policy/iu.test(message.text())) {
      violations.push(message.text());
    }
  });
  await page.exposeFunction("reportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.reportCspViolation(
        `${event.effectiveDirective} blocked ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`
      );
    });
  });
  return violations;
};

/** Playwright's `test`, failing any test that violates the app's CSP. */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations = await recordCspViolations(page);
      await use(violations);
      expect(violations).toStrictEqual([]);
    },
    { auto: true },
  ],
});
