import { z } from "zod";

/**
 * A feature's name, as core's `Feature` names them. Core ignores a name it
 * doesn't know, so a flag for a feature a later release adds can be set
 * before it ships.
 */
export const featureNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u, "Lowercase letters, digits and _");
