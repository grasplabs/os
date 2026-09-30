import { workflowTests } from "@grasp-os/sdk/testing";

import extract from "./extract.ts";

const input = {
  source: {
    title: "Interview with the controller",
    medium: "interview",
    date: "2026-09-21",
    from: "Anna",
  },
  notes: "Closing the month takes three days.",
};

const found = {
  statements: [
    {
      text: "Closing the month takes three days.",
      tags: ["time_sink"],
      quote: "Closing the month takes three days.",
    },
  ],
};

export default workflowTests(extract, [
  {
    name: "keeps what the model found in the notes as a draft for review",
    input,
    mocks: { extract: found, propose: { ok: { id: "draft-1" } } },
    expect: {
      output: { draft: "draft-1", statements: 1 },
      sideEffects: [
        {
          name: "propose",
          input: {
            source: { ...input.source, notes: input.notes },
            statements: found.statements,
          },
        },
      ],
    },
  },
  {
    name: "fails when the draft isn't kept",
    input,
    mocks: { extract: found, propose: { error: "knowledge.forbidden" } },
    expect: { error: "The draft wasn't kept: knowledge.forbidden" },
  },
]);
