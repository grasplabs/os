import { callServer } from "@grasp-os/sdk/screen";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import { useState } from "react";

import { recordOf } from "./playbook";
import type { Outcome, Workflow } from "./playbook";

/**
 * Links a designed workflow to the App workflow built from it, by the
 * App's and the workflow's IDs, as its next version. Linking opens that
 * version, so it waits while the editor holds unsaved changes (`blocked`),
 * which would be lost, and while anything else is on its way (`busy`).
 * `onLink` runs the link it is given, and opens what it saved.
 */
export const LinkForm = ({
  workflow,
  blocked,
  busy,
  onLink,
}: {
  workflow: Workflow;
  blocked: boolean;
  busy: boolean;
  onLink: (link: () => Promise<Outcome<unknown>>) => void;
}) => {
  const linked = recordOf(workflow).app;
  const [appId, setAppId] = useState(linked?.appId ?? "");
  const [workflowId, setWorkflowId] = useState(linked?.workflowId ?? "");
  const link = async (): Promise<Outcome<unknown>> =>
    await callServer<Outcome<unknown>>("link", {
      documentId: workflow.id,
      ifVersion: workflow.version,
      appId: appId.trim(),
      workflowId: workflowId.trim(),
    });
  const empty = appId.trim() === "" || workflowId.trim() === "";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Link to an App workflow</CardTitle>
      </CardHeader>
      <CardContent>
        <fieldset
          aria-label="Link"
          disabled={busy}
          className="flex min-w-0 flex-col gap-2"
        >
          {linked === undefined ? null : (
            <p aria-label="Linked App workflow" className="text-sm">
              Linked to workflow{" "}
              <Badge variant="secondary">{linked.workflowId}</Badge> of App{" "}
              <Badge variant="secondary">{linked.appId}</Badge>
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Input
              aria-label="App ID"
              placeholder="App ID"
              value={appId}
              onChange={(event) => {
                setAppId(event.target.value);
              }}
            />
            <Input
              aria-label="Workflow ID"
              placeholder="Workflow ID"
              value={workflowId}
              onChange={(event) => {
                setWorkflowId(event.target.value);
              }}
            />
            <Button
              variant="outline"
              disabled={empty || blocked}
              onClick={() => {
                onLink(link);
              }}
            >
              Link
            </Button>
            {blocked ? (
              <span className="text-muted-foreground self-center text-sm">
                Save first, then link it.
              </span>
            ) : null}
          </div>
        </fieldset>
      </CardContent>
    </Card>
  );
};
