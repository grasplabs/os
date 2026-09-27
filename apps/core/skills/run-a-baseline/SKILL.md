---
name: run-a-baseline
description: Runs a baseline of how the company works today, from interviews and documents to drawn workflows and a dated snapshot in the Playbook. Use at the start of an engagement, or when asked where the company stands.
---

# Run a baseline

A baseline records how work is done now, before anything changes, so later gains can be measured against it. Everything goes into the Playbook as records.

## Steps

1. **Set the frame.** Check there is a `vision` record and a `team` record for every team in scope. Ask for what's missing; don't invent it.
2. **Collect sources.** For each interview, chat or document, save a `source` record with its `medium`, `date` and the `person` it came from.
3. **Pull out statements.** From each source, save one `statement` per claim, with its `source` and a `topic`: `goal`, `blocker`, `time_sink`, `handover`, `tool` or `rule`. Quote briefly; keep one claim per record.
4. **Name people and tools.** Save a `person` record (with `role` and `team`) for everyone who does work in a workflow, and a `tool` record for every system they use.
5. **Draw the workflows.** For every recurring piece of work the statements describe, draw a workflow as it runs today: see the `draw-a-workflow` skill.
6. **Freeze it.** Save a `snapshot` record dated today, listing every drawn workflow at its current version, with a `maturity` from 0 to 5.

## Good to know

- Mark every number `estimated` unless it was measured; runs mark theirs `observed` later.
- Rules people follow ("two signatures over € 5,000") become `rulebook-entry` records, not steps.
- Ask when statements disagree. Record both, each with its source.
