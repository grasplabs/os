import { coreProject, screenTests } from "./vite.config.ts";

export default coreProject({
  name: "@grasp-os/core:screens",
  include: screenTests,
  // Core bundles the screen compiler from its build output. Only this
  // project builds it: Vitest runs every project's global setup before any
  // test, so the build is there for core's other tests too.
  globalSetup: ["../../packages/compiler/build.ts"],
  // Projects run in groups, lowest first: this one after all the others.
  sequence: { groupOrder: 1 },
});
