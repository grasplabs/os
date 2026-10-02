import type { AppVersion } from "@grasp-os/shared/apps";
import { maxFailedStarts } from "@grasp-os/shared/workflows";
import type {
  RunsPage,
  OutlineNode,
  ParamValue,
  StepOutline,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowParam,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { dateTime, RunsTable } from "../workflows/runs.tsx";

// One workflow: its steps in plain words, read from its code; its
// parameters as a form, for the App's builders; a Test that dry-runs it
// with the values set now; and its history, the runs and, for builders,
// the App's versions. Core checks every call; the page offers only what
// core says the person may do.

/** What a step does besides plain code, in words. */
const kindLabels: Readonly<
  Record<StepOutline["kind"], MessageDescriptor | undefined>
> = {
  exact: undefined,
  ai: msg`AI`,
  decision: msg`Decision`,
  wait: msg`Waits`,
};

const StepItem = ({ step }: { step: StepOutline }) => {
  const { t } = useLingui();
  const kindLabel = kindLabels[step.kind];
  const kind = kindLabel === undefined ? undefined : i18n._(kindLabel);
  const { name, key } = step;
  return (
    <li className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{step.description}</span>
        {kind === undefined ? null : <Badge variant="secondary">{kind}</Badge>}
        {step.sideEffect ? (
          <Badge variant="outline">
            <Trans>Changes something</Trans>
          </Badge>
        ) : null}
      </span>
      <span className="text-muted-foreground text-xs">
        {key === undefined ? name : t`${name}, per ${key}`}
      </span>
    </li>
  );
};

/** The key of an outline node among its siblings. */
const keyOf = (node: OutlineNode): string =>
  node.type === "step" ? node.name : `${node.type}:${node.line}`;

/** Steps, and the branches and loops around them, in the order they run. */
const Outline = ({ nodes }: { nodes: OutlineNode[] }) => {
  const { t } = useLingui();
  return (
    <ol className="flex list-decimal flex-col gap-3 pl-6">
      {nodes.map((node) => {
        if (node.type === "step") {
          return <StepItem key={keyOf(node)} step={node} />;
        }
        if (node.type === "loop") {
          return (
            <li className="flex flex-col gap-2" key={keyOf(node)}>
              <span>
                {node.header === ""
                  ? t`Repeats, once per item:`
                  : t`Repeats, ${node.header}:`}
              </span>
              <Outline nodes={node.steps} />
            </li>
          );
        }
        return (
          <li className="flex flex-col gap-2" key={keyOf(node)}>
            {/* Core leaves the condition out for those who don't build. */}
            <span>
              {node.condition === ""
                ? t`Only when a condition holds:`
                : t`If ${node.condition}:`}
            </span>
            <Outline nodes={node.steps} />
            {node.otherwise.length === 0 ? null : (
              <>
                <span>
                  <Trans>Otherwise:</Trans>
                </span>
                <Outline nodes={node.otherwise} />
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
};

const Steps = ({ steps }: { steps: WorkflowDetail["steps"] }) => {
  const { t } = useLingui();
  if (!steps.ok) {
    const { message } = steps;
    return (
      <p className="text-muted-foreground text-sm">
        {t`The steps can't be read from this workflow's code: ${message}`}
      </p>
    );
  }
  if (steps.outline.steps.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>It has no steps.</Trans>
      </p>
    );
  }
  return <Outline nodes={steps.outline.steps} />;
};

/** How many digits after the point an amount of `currency` has. */
const fractionDigits = (currency: string | undefined): number =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "EUR",
  }).resolvedOptions().maximumFractionDigits ?? 2;

/**
 * A value as its field shows it: money in whole units of its currency
 * (core keeps minor units), anything else as it is.
 */
const shownValue = (param: WorkflowParam, value: ParamValue): string =>
  param.kind === "money" && typeof value === "number"
    ? String(value / 10 ** fractionDigits(param.currency))
    : String(value);

/**
 * What a field's text sets: money in minor units, numbers as numbers,
 * anything else as text. Core checks the value either way.
 */
const valueOf = (param: WorkflowParam, text: string): ParamValue => {
  if (param.kind === "money") {
    return Math.round(Number(text) * 10 ** fractionDigits(param.currency));
  }
  return param.kind === "number" ? Number(text) : text;
};

const isNumeric = (param: WorkflowParam): boolean =>
  param.kind === "money" || param.kind === "number";

/** An amount as typed: digits, and after a point, more of them. */
const amountPattern = /^-?\d+(?:\.(?<fraction>\d+))?$/u;

/**
 * Why a field's text isn't a value of its parameter's kind, where the page
 * can tell: an amount with more decimals than its currency has is refused,
 * never rounded. Core checks every value again.
 */
const inputError = (param: WorkflowParam, text: string): string | undefined => {
  const typed = text.trim();
  if (typed === "") {
    return undefined;
  }
  if (param.kind === "money") {
    const amount = amountPattern.exec(typed);
    if (amount === null) {
      return i18n._(msg`Enter an amount, such as 12.50.`);
    }
    const digits = fractionDigits(param.currency);
    const decimals = amount.groups?.fraction?.length ?? 0;
    if (decimals > digits) {
      const currency = param.currency ?? i18n._(msg`this currency`);
      return digits === 0
        ? i18n._(msg`An amount in ${currency} has no decimals.`)
        : i18n._(
            msg`An amount in ${currency} has at most ${plural(digits, { one: "# decimal", other: "# decimals" })}.`
          );
    }
    return undefined;
  }
  if (param.kind === "number" && Number.isNaN(Number(typed))) {
    return i18n._(msg`Enter a number.`);
  }
  return undefined;
};

/** One parameter's field, saved on its own. */
const ParamField = ({
  app,
  workflow,
  param,
  editable,
  onSaved,
}: {
  app: string;
  workflow: string;
  param: WorkflowParam;
  editable: boolean;
  onSaved: (param: WorkflowParam) => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const stored = param.value ?? param.default;
  const current = shownValue(param, stored);
  const [draft, setDraft] = useState(current);
  const [saved, setSaved] = useState(false);
  const id = `param-${param.name}`;
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const invalid = inputError(param, draft);
  const fallback =
    param.currency === undefined
      ? shownValue(param, param.default)
      : `${shownValue(param, param.default)} ${param.currency}`;
  const save = async (): Promise<void> => {
    setSaved(false);
    const updated = await run(
      async (session) =>
        await session.workflows.params.set(
          app,
          workflow,
          param.name,
          valueOf(param, draft)
        )
    );
    if (updated !== undefined) {
      onSaved(updated);
      setSaved(true);
    }
  };
  return (
    <form
      aria-labelledby={labelId}
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <span className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor={id} id={labelId}>
          {param.label}
        </label>
        {param.sensitive ? (
          <Badge variant="destructive">
            <Trans>Sensitive</Trans>
          </Badge>
        ) : null}
      </span>
      <div className="flex gap-2">
        <Input
          aria-describedby={invalid === undefined ? undefined : errorId}
          aria-invalid={invalid !== undefined}
          disabled={!editable}
          id={id}
          inputMode={isNumeric(param) ? "decimal" : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          value={draft}
        />
        {editable ? (
          <Button
            // By value, not text: "5000.0" is the 5000 already set.
            disabled={
              busy ||
              draft.trim() === "" ||
              invalid !== undefined ||
              valueOf(param, draft) === stored
            }
            type="submit"
          >
            <Trans>Save</Trans>
          </Button>
        ) : null}
      </div>
      {invalid === undefined ? null : (
        <p className="text-destructive text-sm" id={errorId}>
          {invalid}
        </p>
      )}
      <span className="text-muted-foreground text-xs">
        {t`Default: ${fallback}`}
      </span>
      {saved ? (
        <output className="text-sm">
          <Trans>Saved.</Trans>
        </output>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

const Parameters = ({
  app,
  workflow,
  params,
  editable,
}: {
  app: string;
  workflow: string;
  params: WorkflowParam[];
  editable: boolean;
}) => {
  // What core returned for each parameter saved here, over what the page
  // loaded with; each field keeps its own text.
  const [saved, setSaved] = useState<ReadonlyMap<string, WorkflowParam>>(
    new Map()
  );
  const { t } = useLingui();
  if (params.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>It has no parameters.</Trans>
      </p>
    );
  }
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        {editable
          ? t`A change applies to runs that start after it: runs already going keep the values they started with. Each change is recorded, without its value.`
          : t`Grasp staff can read parameters, not change them.`}
      </p>
      {params.map((loaded) => (
        <ParamField
          app={app}
          editable={editable}
          key={loaded.name}
          onSaved={(param) => {
            setSaved((previous) => new Map([...previous, [param.name, param]]));
          }}
          param={saved.get(loaded.name) ?? loaded}
          workflow={workflow}
        />
      ))}
    </div>
  );
};

/** Dry-runs the workflow, and shows what each of its tests' runs did. */
const TestButton = ({ app, workflow }: { app: string; workflow: string }) => {
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [tested, setTested] = useState<WorkflowDryRun>();
  const { t } = useLingui();
  const test = async (): Promise<void> => {
    setOpen(true);
    setTested(undefined);
    const result = await run(
      async (session) => await session.workflows.test(app, workflow)
    );
    setTested(result);
  };
  return (
    <>
      <Button
        disabled={busy}
        onClick={() => {
          void test();
        }}
        variant="outline"
      >
        {busy ? t`Testing…` : t`Test`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-h-svh overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t`Test of ${workflow}`}</DialogTitle>
            <DialogDescription>
              <Trans>
                Runs the workflow&apos;s own test cases with the values set now.
                Nothing is changed: what it would change is listed instead.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          {busy ? (
            <p className="text-sm">
              <Trans>Testing…</Trans>
            </p>
          ) : null}
          <ErrorText>{failure}</ErrorText>
          {tested === undefined ? null : <DryRunReports tested={tested} />}
        </DialogContent>
      </Dialog>
    </>
  );
};

const DryRunReports = ({ tested }: { tested: WorkflowDryRun }) => {
  const { t } = useLingui();
  const { version } = tested;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">{t`Version ${version}`}</p>
      {tested.runs.map((dryRun, index) => (
        // Tests may share a name; their order is the tests' own.
        <section
          className="flex flex-col gap-2"
          key={`${index}:${dryRun.name}`}
        >
          <h3 className="font-medium">
            {dryRun.status === "completed"
              ? t`${dryRun.name}: completed`
              : t`${dryRun.name}: failed`}
          </h3>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
            {dryRun.report}
          </pre>
        </section>
      ))}
    </div>
  );
};

const Versions = ({ versions }: { versions: Loaded<AppVersion[]> }) => {
  if (versions.state !== "ready") {
    return <NotLoaded page={versions} />;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Version</Trans>
          </TableHead>
          <TableHead>
            <Trans>What changed</Trans>
          </TableHead>
          <TableHead>
            <Trans>Committed</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.data.map((version) => (
          <TableRow key={version.version}>
            <TableCell>{version.version}</TableCell>
            <TableCell>{version.message}</TableCell>
            <TableCell>
              {dateTime.format(new Date(version.createdAt))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const WorkflowView = ({
  detail,
  runs,
  versions,
}: {
  detail: WorkflowDetail;
  runs: Loaded<RunsPage>;
  versions: Loaded<AppVersion[]> | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const { summary, steps, params, setsParams } = detail;
  const { t } = useLingui();
  const { version } = summary;
  const owner = summary.owner.name ?? summary.owner.userId;
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium">{summary.workflow}</h1>
          <p className="text-muted-foreground text-sm">
            <Link
              className="underline"
              params={{ app: summary.app }}
              to="/apps/$app"
            >
              {summary.appName}
            </Link>
            {summary.owner.userId === identity.userId
              ? t`, version ${version}, owned by you`
              : t`, version ${version}, owned by ${owner}`}
          </p>
          {summary.scheduleStopped ? (
            <p className="text-destructive text-sm">
              {t`Its schedule stopped: its run failed to start ${maxFailedStarts} times in a row. It starts again when its schedule is set under Parameters, or when a new version of the App is made current.`}
            </p>
          ) : null}
        </div>
        {params === null ? null : (
          <TestButton app={summary.app} workflow={summary.workflow} />
        )}
      </div>
      <Tabs defaultValue="steps">
        <TabsList>
          <TabsTrigger value="steps">
            <Trans>Steps</Trans>
          </TabsTrigger>
          {params === null ? null : (
            <TabsTrigger value="parameters">
              <Trans>Parameters</Trans>
            </TabsTrigger>
          )}
          <TabsTrigger value="history">
            <Trans>History</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="steps">
          <Steps steps={steps} />
        </TabsContent>
        {/* Kept while another tab shows: what was saved or typed stays. */}
        {params === null ? null : (
          <TabsContent keepMounted value="parameters">
            <Parameters
              app={summary.app}
              editable={setsParams}
              params={params}
              workflow={summary.workflow}
            />
          </TabsContent>
        )}
        <TabsContent value="history">
          <div className="flex flex-col gap-6">
            <section aria-labelledby="runs" className="flex flex-col gap-2">
              <h2 className="font-medium" id="runs">
                <Trans>Runs</Trans>
              </h2>
              {runs.state === "ready" ? (
                <RunsTable
                  me={identity.userId}
                  more={runs.data.more}
                  runs={runs.data.runs}
                  withWorkflow={false}
                />
              ) : (
                <NotLoaded page={runs} />
              )}
            </section>
            {versions === undefined ? null : (
              <section
                aria-labelledby="versions"
                className="flex flex-col gap-2"
              >
                <h2 className="font-medium" id="versions">
                  <Trans>Versions of the App</Trans>
                </h2>
                <Versions versions={versions} />
              </section>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
};

const WorkflowPage = () => {
  const { detail, runs, versions } = Route.useLoaderData();
  const { app, workflow } = Route.useParams();
  const { t } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Workflows`, to: "/workflows" },
          { label: workflow },
        ]}
      />
      <div className="flex max-w-6xl flex-col gap-6 p-6">
        {detail.state === "ready" ? (
          <WorkflowView
            // Another workflow starts with its own forms and test.
            key={`${app}/${workflow}`}
            detail={detail.data}
            runs={runs}
            versions={versions}
          />
        ) : (
          <>
            <h1 className="text-2xl font-medium">{workflow}</h1>
            <NotLoaded page={detail} />
          </>
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/workflows/$app/$workflow")({
  // The workflow and its runs are read on their own, and the App's
  // versions only for those who build it: each says on its own why it
  // failed.
  loader: async ({ context: { core }, params: { app, workflow } }) => {
    const [detail, runs] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.workflows.get(app, workflow)
      ),
      loadFromCore(
        core,
        async (session) => await session.workflows.runs({ app, workflow })
      ),
    ]);
    const builds = detail.state === "ready" && detail.data.params !== null;
    const versions = builds
      ? await loadFromCore(
          core,
          async (session) => await session.apps.versions.list(app)
        )
      : undefined;
    return { detail, runs, versions };
  },
  component: WorkflowPage,
});
