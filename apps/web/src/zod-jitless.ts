import { config } from "zod";

// The page's CSP (core's src/security-headers.ts) allows no eval. Zod probes
// for it with `new Function` when a schema is built, which the browser
// reports as a violation even though Zod catches the error. Imported first
// in main.tsx, so this runs before any module builds a schema.
config({ jitless: true });
