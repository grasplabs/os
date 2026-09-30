// Compile-time guarantee that each stub a preview hands a draft's server
// code (preview-bindings.ts) has exactly the methods of the binding it
// stands in for: a method the real binding gains and the stub lacks would
// fail a correct draft's check on a call nothing the agent writes can
// fix, and one only the stub has would pass in a preview and fail live.
// This file is type-checked by `vp check` and never run.
import type { WorkerEntrypoint } from "cloudflare:workers";
import { expectTypeOf } from "vite-plus/test";

import type { AppConnectionBinding } from "../src/app-bindings.ts";
import type { AppExportBinding } from "../src/app-calls.ts";
import type { AppGuestsBinding } from "../src/guests-binding.ts";
import type { AppCollectionBinding } from "../src/knowledge/app-binding.ts";
import type {
  PreviewCollection,
  PreviewConnection,
  PreviewExports,
  PreviewGuests,
  PreviewStatistics,
} from "../src/preview-bindings.ts";
import type { AppStatisticsBinding } from "../src/statistics-binding.ts";

/** What App code can call on a binding: its own public methods. */
type MethodsOf<Binding> = Exclude<keyof Binding, keyof WorkerEntrypoint>;

expectTypeOf<MethodsOf<PreviewConnection>>().toEqualTypeOf<
  MethodsOf<AppConnectionBinding>
>();
expectTypeOf<MethodsOf<PreviewExports>>().toEqualTypeOf<
  MethodsOf<AppExportBinding>
>();
expectTypeOf<MethodsOf<PreviewCollection>>().toEqualTypeOf<
  MethodsOf<AppCollectionBinding>
>();
expectTypeOf<MethodsOf<PreviewStatistics>>().toEqualTypeOf<
  MethodsOf<AppStatisticsBinding>
>();
expectTypeOf<MethodsOf<PreviewGuests>>().toEqualTypeOf<
  MethodsOf<AppGuestsBinding>
>();
