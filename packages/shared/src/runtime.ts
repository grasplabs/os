/**
 * The Workers compatibility date Grasp OS runs on, for Workers started from
 * code (Dynamic Workers, test isolates). The wrangler.jsonc files can't
 * import it and repeat it; change them together.
 */
export const compatibilityDate = "2026-09-15";

/**
 * What every isolate started through the Worker Loader shares: this date,
 * and no importable env, so its code sees only the env its loader gives it.
 * Each loader adds its own limits and `globalOutbound`.
 */
export const isolateBase: {
  compatibilityDate: string;
  compatibilityFlags: string[];
} = {
  compatibilityDate,
  compatibilityFlags: ["disallow_importable_env"],
};
