import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";

import {
  formatHours,
  numberNames,
  shortTextMax,
  stepHours,
  stepKinds,
  stepNumberMax,
  stepsMax,
} from "./totals";
import type { Basis, NumberName, Step, StepKind } from "./totals";

const bases: { value: Basis; label: string }[] = [
  { value: "estimated", label: "Estimated" },
  { value: "observed", label: "Observed" },
];

/** A step with one of its numbers set from what was typed, or cleared. */
const withNumber = (step: Step, name: NumberName, typed: string): Step => {
  const { [name]: previous, ...others } = step.numbers ?? {};
  const value = Number(typed);
  if (typed.trim() === "" || !Number.isFinite(value)) {
    // A step with no numbers left has none, as the Playbook stores it.
    const { numbers: _cleared, ...without } = step;
    return Object.keys(others).length === 0
      ? without
      : { ...step, numbers: others };
  }
  return {
    ...step,
    numbers: {
      ...others,
      [name]: { value, basis: previous?.basis ?? "estimated" },
    },
  };
};

/** A step with the basis of one of its numbers changed. */
const withBasis = (step: Step, name: NumberName, basis: Basis): Step => {
  const number = step.numbers?.[name];
  return number === undefined
    ? step
    : { ...step, numbers: { ...step.numbers, [name]: { ...number, basis } } };
};

const NumberCell = ({
  step,
  position,
  name,
  label,
  onChange,
}: {
  step: Step;
  position: number;
  name: NumberName;
  label: string;
  onChange: (step: Step) => void;
}) => {
  const number = step.numbers?.[name];
  return (
    <TableCell>
      <div className="flex flex-col gap-1">
        <Input
          aria-label={`${label}, step ${position}`}
          type="number"
          min={0}
          max={stepNumberMax}
          value={number?.value ?? ""}
          onChange={(event) => {
            onChange(withNumber(step, name, event.target.value));
          }}
        />
        <Select
          items={bases}
          value={number?.basis ?? "estimated"}
          disabled={number === undefined}
          onValueChange={(basis: Basis | null) => {
            if (basis !== null) {
              onChange(withBasis(step, name, basis));
            }
          }}
        >
          <SelectTrigger aria-label={`${label} basis, step ${position}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {bases.map((basis) => (
              <SelectItem key={basis.value} value={basis.value}>
                {basis.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </TableCell>
  );
};

const StepRow = ({
  step,
  position,
  designed,
  disabled,
  onChange,
  onRemove,
}: {
  step: Step;
  position: number;
  designed: boolean;
  /** The row's fieldset disables the rest; the checkbox isn't a form field. */
  disabled: boolean;
  onChange: (step: Step) => void;
  onRemove: () => void;
}) => (
  <TableRow>
    <TableCell>
      <Input
        aria-label={`Name, step ${position}`}
        maxLength={shortTextMax}
        value={step.name}
        onChange={(event) => {
          onChange({ ...step, name: event.target.value });
        }}
      />
    </TableCell>
    <TableCell>
      <Input
        aria-label={`Who, step ${position}`}
        maxLength={shortTextMax}
        value={step.who ?? ""}
        onChange={(event) => {
          onChange({ ...step, who: event.target.value });
        }}
      />
    </TableCell>
    <TableCell>
      <Input
        aria-label={`Tool, step ${position}`}
        maxLength={shortTextMax}
        value={step.tool ?? ""}
        onChange={(event) => {
          onChange({ ...step, tool: event.target.value });
        }}
      />
    </TableCell>
    <TableCell>
      <Checkbox
        aria-label={`Handover, step ${position}`}
        checked={step.handover}
        disabled={disabled}
        onCheckedChange={(checked) => {
          onChange({ ...step, handover: checked });
        }}
      />
    </TableCell>
    {designed ? (
      <TableCell>
        <Select
          items={stepKinds}
          value={step.kind ?? null}
          onValueChange={(kind: StepKind | null) => {
            onChange({ ...step, kind: kind ?? undefined });
          }}
        >
          <SelectTrigger aria-label={`Type, step ${position}`}>
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {stepKinds.map((kind) => (
              <SelectItem key={kind.value} value={kind.value}>
                {kind.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
    ) : null}
    {numberNames.map(({ name, label }) => (
      <NumberCell
        key={name}
        step={step}
        position={position}
        name={name}
        label={label}
        onChange={onChange}
      />
    ))}
    <TableCell>{formatHours(stepHours(step))}</TableCell>
    <TableCell>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Remove step ${position}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </TableCell>
  </TableRow>
);

/** A workflow's steps, each with who does it, the tool, and its numbers. */
export const StepsEditor = ({
  steps,
  designed,
  disabled,
  onChange,
}: {
  steps: Step[];
  designed: boolean;
  /** While the editor is busy (see its fieldset). */
  disabled: boolean;
  onChange: (steps: Step[]) => void;
}) => {
  const change = (position: number, step: Step): void => {
    onChange(steps.map((each, index) => (index === position ? step : each)));
  };
  return (
    <div className="flex flex-col gap-2">
      <Table aria-label="Steps">
        <TableHeader>
          <TableRow>
            <TableHead>Step</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Handover</TableHead>
            {designed ? <TableHead>Type</TableHead> : null}
            {numberNames.map(({ name, label }) => (
              <TableHead key={name}>{label}</TableHead>
            ))}
            <TableHead>Hours a week</TableHead>
            <TableHead>
              <span className="sr-only">Remove</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map((step, index) => (
            <StepRow
              key={index}
              step={step}
              position={index + 1}
              designed={designed}
              disabled={disabled}
              onChange={(changed) => {
                change(index, changed);
              }}
              onRemove={() => {
                onChange(steps.filter((_, other) => other !== index));
              }}
            />
          ))}
        </TableBody>
      </Table>
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={steps.length >= stepsMax}
          onClick={() => {
            onChange([...steps, { name: "", handover: false }]);
          }}
        >
          Add a step
        </Button>
      </div>
    </div>
  );
};
