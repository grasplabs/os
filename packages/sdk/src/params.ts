import { z } from "zod";

/**
 * The value each kind of parameter holds. References to people, models,
 * templates and schedules are branded, so a parameter of one kind can't be
 * passed where another is expected (a reviewer as the model, say).
 */
export const paramValueSchemas = {
  /**
   * An amount in whole minor units of the parameter's currency (cents for
   * EUR), so amounts add up exactly.
   */
  money: z.int(),
  number: z.number(),
  text: z.string(),
  /** A person or a group of people. */
  person: z.string().min(1).brand<"Person">(),
  /** When something happens, as a cron expression. */
  schedule: z.string().min(1).brand<"Schedule">(),
  /** A model offered by the model gateway. */
  model: z.string().min(1).brand<"Model">(),
  /** A template, e.g. for an email. */
  template: z.string().min(1).brand<"Template">(),
};

/** An ISO 4217 currency code, e.g. `EUR`. */
export const currencySchema = z.string().regex(/^[A-Z]{3}$/u);

export type ParamKind = keyof typeof paramValueSchemas;
export type ParamValue<Kind extends ParamKind> = z.output<
  (typeof paramValueSchemas)[Kind]
>;
export type ParamDefault<Kind extends ParamKind> = z.input<
  (typeof paramValueSchemas)[Kind]
>;
