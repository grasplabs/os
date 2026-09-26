import { coreProject, screenTests } from "./vite.config.ts";

export default coreProject({
  name: "@grasp-os/core:screens",
  include: screenTests,
  // Projects run in groups, lowest first: this one after all the others.
  sequence: { groupOrder: 1 },
});
