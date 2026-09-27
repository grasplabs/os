import { defineErrorFamily } from "./errors.ts";

/** Why the model gateway refused or failed a model call. */
export const modelErrors = defineErrorFamily({
  "model.invalid_call": "That isn't a valid model call.",
  "model.unconfigured": "Models aren't set up for this deployment yet.",
  "model.not_allowed": "This deployment doesn't allow that model.",
  "model.eu_only":
    "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
  "model.sensitive_data":
    "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
  "model.failed": "The model call failed. Try again later.",
  "model.invalid_output":
    "The model's answer didn't match the expected shape, also when asked again.",
});
