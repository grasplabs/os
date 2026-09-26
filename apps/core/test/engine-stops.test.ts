import { describe, expect, it } from "vite-plus/test";

import { isEngineStop } from "../src/workflows/host.ts";

// Which of the engine's errors mean it stopped an execution to resume or
// end the run itself, so the run didn't fail: only someone pausing,
// cancelling, restarting or deleting it. The engine's messages as the
// local runtime (Miniflare) throws them; GRA-44 confirms production's.

const engineError = (message: string, name = "Error"): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

describe("engine stops", () => {
  it("count someone pausing, cancelling, restarting or deleting a run, also with the name in front", () => {
    const stops = ["pause", "terminate", "restart", "delete"].flatMap(
      (action) => [
        `Aborting engine: User called ${action}`,
        `Error: Aborting engine: User called ${action}`,
      ]
    );

    expect(
      stops.filter((message) => !isEngineStop(engineError(message)))
    ).toStrictEqual([]);
  });

  it("don't count the engine failing a run, or anything else", () => {
    const failures = [
      "Aborting engine: A step threw a NonRetryableError",
      "Aborting engine: Value is not serialisable",
      "Aborting engine: Storage limit exceeded",
      "Aborting engine: Grace period complete",
      "Aborting engine: User called pause, and more",
      'Step name "bell" exceeds max length (256 chars) or invalid characters found',
      "The limit of 25 steps has been reached. This limit can be changed in your worker configuration.",
      "Execution timed out after 500ms",
    ];

    expect({
      failures: failures.filter((message) =>
        isEngineStop(engineError(message))
      ),
      notAnError: isEngineStop("Aborting engine: User called pause"),
    }).toStrictEqual({ failures: [], notAnError: false });
  });
});
