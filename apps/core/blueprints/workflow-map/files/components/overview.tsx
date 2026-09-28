import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";

import { recordOf } from "./playbook";
import type { Team, Workflow } from "./playbook";
import { formatHours, totalsOf } from "./totals";

/** The workflows of one team, or of none, in title order. */
interface Group {
  key: string;
  title: string;
  workflows: Workflow[];
}

const noTeam = "No team";

const titleOf = (workflow: Workflow): string =>
  recordOf(workflow).title ?? workflow.path;

/** The workflows by team: each team in title order, then those without one. */
const groupsOf = (workflows: Workflow[], teams: Team[]): Group[] => {
  const titles = new Map(teams.map(({ path, title }) => [path, title]));
  const groups = new Map<string, Group>();
  for (const workflow of workflows) {
    const { team } = recordOf(workflow);
    const key = team ?? "";
    const group = groups.get(key) ?? {
      key,
      title: team === undefined ? noTeam : (titles.get(team) ?? team),
      workflows: [],
    };
    group.workflows.push(workflow);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      workflows: group.workflows.toSorted((a, b) =>
        titleOf(a).localeCompare(titleOf(b))
      ),
    }))
    .toSorted((a, b) => {
      if (a.key === "" || b.key === "") {
        return a.key === "" ? 1 : -1;
      }
      return a.title.localeCompare(b.title);
    });
};

const WorkflowRow = ({
  workflow,
  onOpen,
}: {
  workflow: Workflow;
  onOpen: (id: string) => void;
}) => {
  const record = recordOf(workflow);
  const totals = totalsOf(record.steps);
  const title = titleOf(workflow);
  return (
    <TableRow>
      <TableCell>
        <Button
          variant="link"
          onClick={() => {
            onOpen(workflow.id);
          }}
        >
          {title}
        </Button>
      </TableCell>
      <TableCell>
        <Badge variant={record.state === "designed" ? "default" : "outline"}>
          {record.state}
        </Badge>
      </TableCell>
      <TableCell>{formatHours(totals.hoursPerWeek)}</TableCell>
      <TableCell>{totals.people}</TableCell>
      <TableCell>{totals.handovers}</TableCell>
      <TableCell>
        {record.gain === undefined ? "" : formatHours(record.gain.hoursPerWeek)}
      </TableCell>
    </TableRow>
  );
};

/** Every workflow, by team, with its state and totals. */
export const WorkflowList = ({
  workflows,
  teams,
  writable,
  onOpen,
}: {
  workflows: Workflow[];
  teams: Team[];
  /** Whether the person may draw one: only then are they asked to. */
  writable: boolean;
  onOpen: (id: string) => void;
}) => {
  if (workflows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {writable
          ? "No workflows yet. Draw the first one."
          : "No workflows yet."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groupsOf(workflows, teams).map((group) => (
        <Card key={group.key}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table aria-label={`Workflows of ${group.title}`}>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Hours a week</TableHead>
                  <TableHead>People</TableHead>
                  <TableHead>Handovers</TableHead>
                  <TableHead>Expected gain</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.workflows.map((workflow) => (
                  <WorkflowRow
                    key={workflow.id}
                    workflow={workflow}
                    onOpen={onOpen}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};
