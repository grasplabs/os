import type {
  ModelBudget,
  ModelBudgetScope,
  ModelRulesSettings,
  ModelSettings,
  ModelSpender,
} from "@grasp-os/shared/models";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Models, for admins: the models the deployment allows, the client's rules
// for model calls (EU routing, which models take sensitive data, budgets),
// and this month's spend against each budget. They are deployment config
// that Grasp sets as agreed with the client, so the page only shows them,
// as core reads them; core checks the role.

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** A list of IDs for a sentence, or `none`. */
const listed = (ids: readonly string[]): string =>
  ids.length === 0 ? "none" : ids.join(", ");

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <h2 className="text-lg font-medium" id={id}>
      {title}
    </h2>
    {children}
  </section>
);

const AllowedModels = ({
  models,
  rules,
}: {
  models: string[];
  rules: ModelRulesSettings | undefined;
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Model</TableHead>
        <TableHead>
          <span className="sr-only">Rules</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {models.map((model) => (
        <TableRow key={model}>
          <TableCell>{model}</TableCell>
          <TableCell>
            <span className="flex gap-2">
              {rules?.eu?.models.includes(model) === true ? (
                <Badge variant="secondary">Hosted in the EU</Badge>
              ) : null}
              {rules?.sensitive?.models.includes(model) === true ? (
                <Badge variant="secondary">Takes sensitive data</Badge>
              ) : null}
            </span>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const EuRouting = ({ eu }: { eu: ModelRulesSettings["eu"] }) => {
  if (eu === null) {
    return (
      <p className="text-muted-foreground text-sm">
        No call has to stay in the EU.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>Every call stays in the EU: {eu.deployment ? "yes" : "no"}.</li>
      <li>
        Workflows whose AI steps stay in the EU:{" "}
        {listed(
          eu.workflows.map(({ app, workflow }) => `${workflow} (${app})`)
        )}
        .
      </li>
      <li>Connections whose data stays in the EU: {listed(eu.connections)}.</li>
    </ul>
  );
};

const DataRules = ({
  sensitive,
}: {
  sensitive: ModelRulesSettings["sensitive"];
}) => {
  if (sensitive === null) {
    return (
      <p className="text-muted-foreground text-sm">
        There is no data rule: any allowed model may take sensitive data.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      <li>
        Only the models marked as taking sensitive data may be sent data from a
        sensitive collection (marked in Knowledge) or a sensitive connection, or
        from a chat, App or run that read one.
      </li>
      <li>Sensitive connections: {listed(sensitive.connections)}.</li>
    </ul>
  );
};

const scopeTitles: Record<ModelBudgetScope, string> = {
  deployment: "All calls together",
  workflow: "Each workflow",
  user: "Each person",
};

const spenderName = (of: ModelSpender): string => {
  if (of.type === "deployment") {
    return "All calls";
  }
  if (of.type === "workflow") {
    return `${of.workflowId} in ${of.appName ?? of.appId}`;
  }
  return of.name ?? of.userId;
};

const BudgetTable = ({ budget }: { budget: ModelBudget }) => {
  const title = scopeTitles[budget.scope];
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      <p className="text-muted-foreground text-sm">
        {dollars.format(budget.limit)} a month, admins alerted at{" "}
        {budget.alertAt}%. Calls stop once it&apos;s used up.
      </p>
      {budget.more ? (
        <p className="text-sm">
          The {budget.spent.length} who spent most; more spent less.
        </p>
      ) : null}
      {budget.spent.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing spent yet.</p>
      ) : (
        <Table aria-label={`Spend: ${title}`}>
          <TableHeader>
            <TableRow>
              <TableHead>Spent by</TableHead>
              <TableHead>Spent</TableHead>
              <TableHead>Of the limit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {budget.spent.map(({ of, amount }) => (
              <TableRow key={JSON.stringify(of)}>
                <TableCell>{spenderName(of)}</TableCell>
                <TableCell>{dollars.format(amount)}</TableCell>
                <TableCell>
                  {Math.round((amount / budget.limit) * 100)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
};

const Budgets = ({
  budgets,
  month,
}: {
  budgets: ModelBudget[];
  month: string;
}) => {
  if (budgets.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No budget is set: model calls aren&apos;t limited by cost.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">Spend this month ({month}, UTC).</p>
      {budgets.map((budget) => (
        <BudgetTable budget={budget} key={budget.scope} />
      ))}
    </div>
  );
};

const Settings = ({ settings }: { settings: ModelSettings }) => {
  if (settings.models.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Models aren&apos;t set up for this deployment yet, so no model call can
        be made. Grasp sets them up.
      </p>
    );
  }
  const { rules } = settings;
  const on = rules.state === "on" ? rules : undefined;
  return (
    <>
      {rules.state === "invalid" ? (
        <ErrorText>
          The rules in this deployment&apos;s configuration can&apos;t be read,
          so every model call is refused. Contact Grasp.
        </ErrorText>
      ) : null}
      <Section id="allowed" title="Allowed models">
        <AllowedModels models={settings.models} rules={on} />
      </Section>
      {on === undefined ? null : (
        <>
          <Section id="eu" title="EU routing">
            <EuRouting eu={on.eu} />
          </Section>
          <Section id="data" title="Data rules">
            <DataRules sensitive={on.sensitive} />
          </Section>
          <Section id="budgets" title="Budgets">
            <Budgets budgets={on.budgets} month={settings.month} />
          </Section>
        </>
      )}
    </>
  );
};

const Models = () => {
  const page = Route.useLoaderData();
  return (
    <main className="flex max-w-4xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">Models</h1>
        <p className="text-muted-foreground text-sm">
          Grasp sets these for your organization, as agreed with you. To change
          them, contact Grasp.
        </p>
      </div>
      <NotLoaded page={page} />
      {page.state === "ready" ? <Settings settings={page.data} /> : null}
    </main>
  );
};

export const Route = createFileRoute("/_shell/models")({
  component: Models,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.models.settings()
    ),
});
