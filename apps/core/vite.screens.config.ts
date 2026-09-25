import { coreProject, screenTests } from "./vite.config.ts";

export default coreProject({
  name: "@grasp-os/core:screens",
  include: screenTests,
  // Builds the screen compiler into the assets the tests serve. Only this
  // project does: Vitest runs every project's global setup before any
  // test, so the assets are there for core's other tests too.
  globalSetup: ["./test/global-setup.ts"],
  // Projects run in groups, lowest first: this one after all the others.
  sequence: { groupOrder: 1 },
});
