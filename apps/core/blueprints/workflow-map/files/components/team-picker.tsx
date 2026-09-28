import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useState } from "react";

import type { Outcome, Team } from "./playbook";
import { shortTextMax } from "./totals";

/** A workflow's team, picked from the Playbook's teams, or a new one. */
export const TeamPicker = ({
  teams,
  team,
  onChange,
  onRefused,
}: {
  teams: Team[];
  team: string | null;
  onChange: (team: string | null) => void;
  onRefused: (code: string) => void;
}) => {
  const [added, setAdded] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const items = [
    { value: null, label: "No team" },
    ...[...teams, ...added].map(({ path, title }) => ({
      value: path,
      label: title,
    })),
  ];
  const add = async (): Promise<void> => {
    const answer = await callServer<Outcome<Team>>("addTeam", name.trim());
    if ("error" in answer) {
      onRefused(answer.error);
      return;
    }
    setAdded([...added, answer.ok]);
    setName("");
    onChange(answer.ok.path);
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select
        items={items}
        value={team}
        onValueChange={(value: string | null) => {
          onChange(value);
        }}
      >
        <SelectTrigger aria-label="Team">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="New team"
        placeholder="New team"
        maxLength={shortTextMax}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Button
        variant="outline"
        disabled={name.trim() === ""}
        onClick={() => {
          void add();
        }}
      >
        Add team
      </Button>
    </div>
  );
};
