import path from "node:path";

import { buildConnectors, connectorEntries } from "../build.ts";

/**
 * Connect's connectors as its tests load them: the release's, as build.ts
 * builds them, and the sample connector the tests call through.
 */
export const testConnectorsFile = path.join(
  import.meta.dirname,
  "../dist/test/connectors.js"
);

const setup = async (): Promise<void> => {
  await buildConnectors(
    [
      ...connectorEntries(),
      path.join(import.meta.dirname, "fixtures/sample-connector.ts"),
    ],
    testConnectorsFile
  );
};

export default setup;
