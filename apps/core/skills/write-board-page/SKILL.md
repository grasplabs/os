---
name: write-board-page
description: Writes the one-page board update from the Playbook, with where the company stands, what changed since the last snapshot, what the plan does next and what the board needs to decide. Use before a board or management meeting.
---

# Write the board page

One page a board member reads in two minutes. Every claim comes from the Playbook and links to the record it comes from.

## Sections

1. **Where we stand.** The latest `snapshot`: its date and `maturity`, and the maturity of the one before it.
2. **What changed.** Workflows designed or built since the last snapshot, with the hours a week they save. A snapshot the platform took has `figures`: each workflow's hours `drawn`, `designed`, and `running` (its designed steps at the runs a week observed). Use those numbers as they are, frozen when it was taken. Elsewhere use their `gain.hoursPerWeek`, and their steps' `observed` numbers where there are any. Say plainly which are estimates.
3. **The plan.** `plan-item` records that are `doing`, and the next ones `planned`, each with its `due` date. Name any that slipped.
4. **Decisions needed.** The snapshot's `decisionNeeded`, and `decision` records that are `proposed`, each in one sentence with the choice it asks for.
5. **Risks.** Statements with the topic `blocker` that no plan item addresses yet, and the snapshot's improvement signals (`figures.signals`) that are high.

## Where it goes

Write the page as the snapshot's Markdown, after its frontmatter, and the one decision it asks for as its `decisionNeeded`. Leave the rest of its frontmatter as it is: the board page App shows the page beside the snapshot's numbers, and prints both on one page.

## Good to know

- Lead with the number that matters most: hours saved a week, or maturity.
- No jargon, no step-level detail: link to the workflow instead.
- Keep it to one page. Cut a section to a sentence before cutting a decision.
