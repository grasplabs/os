---
name: draw-a-workflow
description: Draws a workflow record in the Playbook, step by step, with who does each step, in which tool, how often and how long it takes. Use to record how work runs today (drawn) or how it should run (designed).
---

# Draw a workflow

A workflow record is one piece of recurring work, from what starts it to what ends it. Draw it in the workflow map, which keeps it in the Playbook under `workflows/`, with `type: workflow`.

## Steps

1. **Pick the state.** `drawn` for how it runs today; `designed` for how it should run. Draw before you design: a design is measured against the drawing.
2. **Name it** by its outcome, such as "Pay supplier invoices", and set its `team` to the team record that owns it.
3. **List the `steps`** in order. For each: a short `name`, `who` does it (a role), the `tool` used, and `handover: true` when the work passes to someone else after it.
4. **Add each step's `numbers`** where known: `frequency` (times a week), `minutes` (each time) and `people` (each time), each as `{ value, basis }` with a `basis` of `estimated` or `observed`. Numbers belong on a step, never at the top of the record.
5. **Designed only:** give each step its `kind` (`automated`, `ai_checked`, `tool` or `instruction`), list what can be set as `parameters: [{ name, value }]` (such as an approval limit), and estimate the time it saves as `gain: { hoursPerWeek }`.
6. **Write the body** for a person: what starts the work, what done looks like, and the statements it rests on, linked by their paths.
7. **Design it** by saving the same record as `designed`: the map keeps the version of it last drawn, to set beside the design.

## Example step

```yaml
steps:
  - name: Match the invoice
    who: Controller
    tool: Exact Online
    handover: true
    numbers:
      frequency: { value: 40, basis: estimated }
      minutes: { value: 5, basis: observed }
      people: { value: 1, basis: estimated }
```

## Good to know

- Handovers and waiting are where time goes: record every one.
- Keep a step to one person doing one thing. Split steps that aren't.
- A designed workflow names the version of it last drawn (`drawnVersion`), so both can be compared. Once built, it is linked to the App workflow that runs it (`app`). Only the workflow map sets either: an edit of the record's text keeps them as they are.
