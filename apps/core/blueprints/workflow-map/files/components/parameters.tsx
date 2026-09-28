import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";

import { parameterValueMax, parametersMax, shortTextMax } from "./totals";
import type { Parameter } from "./totals";

/** What can be set for a workflow, such as a threshold: a name and a value. */
export const ParametersEditor = ({
  parameters,
  onChange,
}: {
  parameters: Parameter[];
  onChange: (parameters: Parameter[]) => void;
}) => {
  const change = (position: number, parameter: Parameter): void => {
    onChange(
      parameters.map((each, index) => (index === position ? parameter : each))
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Parameters</span>
      {parameters.map((parameter, index) => (
        <div key={index} className="flex gap-2">
          <Input
            aria-label={`Parameter ${index + 1}`}
            placeholder="Name"
            maxLength={shortTextMax}
            value={parameter.name}
            onChange={(event) => {
              change(index, { ...parameter, name: event.target.value });
            }}
          />
          <Input
            aria-label={`Value of parameter ${index + 1}`}
            placeholder="Value"
            maxLength={parameterValueMax}
            value={parameter.value ?? ""}
            onChange={(event) => {
              change(index, { ...parameter, value: event.target.value });
            }}
          />
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={parameters.length >= parametersMax}
          onClick={() => {
            onChange([...parameters, { name: "" }]);
          }}
        >
          Add a parameter
        </Button>
      </div>
    </div>
  );
};
