// Compile-time guarantees of the workflow SDK's typed stub of an App
// (`appServer`), against a server class as App code writes it: one that
// extends the runtime's `DurableObject`. This file is type-checked by
// `vp check` and never run. Here rather than in the SDK, whose types don't
// include the Workers runtime.
import type { AppServer } from "@grasp-os/sdk/workflow";
import type { DurableObject } from "cloudflare:workers";
import { expectTypeOf } from "vite-plus/test";

interface Caller {
  userId: string;
}

/** An App's server, with what core calls and what it refuses. */
declare class InvoiceApp extends DurableObject {
  setStatus(caller: Caller, id: string, status: "booked"): string;
  total(caller: Caller): Promise<number>;
  // Refused by core: reserved, or not starting with a lowercase letter.
  toString(): string;
  get(caller: Caller): string;
  Upper(caller: Caller): string;
  _private(caller: Caller): string;
  set_status(caller: Caller): string;
  "mark-paid"(caller: Caller): string;
}

type Stub = AppServer<InvoiceApp>;

expectTypeOf<Stub["setStatus"]>().toEqualTypeOf<
  (id: string, status: "booked") => Promise<string>
>();
expectTypeOf<Stub["total"]>().toEqualTypeOf<() => Promise<number>>();
// Exactly the methods core calls: no runtime members, no brand, nothing
// reserved, nothing that doesn't start with a lowercase letter.
expectTypeOf<keyof Stub>().toEqualTypeOf<"setStatus" | "total">();
