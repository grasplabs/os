import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";

import {
  emptyStatement,
  quoteMax,
  shortTextMax,
  statementTags,
  statementsMax,
  tagLabels,
} from "./intake";
import type { DraftStatement, StatementTag } from "./intake";

/** `tags` with `tag` in or out, in the order tags are listed. */
const withTag = (
  tags: readonly StatementTag[],
  tag: StatementTag,
  on: boolean
): StatementTag[] =>
  statementTags.filter((each) => (each === tag ? on : tags.includes(each)));

/** One statement: its claim, its tags and its quote. */
const StatementRow = ({
  statement,
  position,
  disabled,
  onChange,
  onRemove,
}: {
  statement: DraftStatement;
  position: number;
  disabled: boolean;
  onChange: (statement: DraftStatement) => void;
  onRemove: () => void;
}) => (
  <li className="flex flex-col gap-2 rounded-md border p-3">
    <div className="flex items-center gap-2">
      <Input
        aria-label={`Statement ${position}`}
        placeholder="One claim, in a sentence"
        maxLength={shortTextMax}
        value={statement.text}
        disabled={disabled}
        onChange={(event) => {
          onChange({ ...statement, text: event.target.value });
        }}
      />
      <Button
        variant="outline"
        disabled={disabled}
        aria-label={`Remove statement ${position}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </div>
    <fieldset className="flex flex-wrap gap-4">
      <legend className="sr-only">Tags, statement {position}</legend>
      {statementTags.map((tag) => (
        <label key={tag} className="flex items-center gap-2 text-sm">
          <Checkbox
            aria-label={`${tagLabels[tag]}, statement ${position}`}
            checked={statement.tags.includes(tag)}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onChange({
                ...statement,
                tags: withTag(statement.tags, tag, checked),
              });
            }}
          />
          {tagLabels[tag]}
        </label>
      ))}
    </fieldset>
    <Textarea
      aria-label={`Quote, statement ${position}`}
      placeholder="What they said, briefly (optional)"
      maxLength={quoteMax}
      value={statement.quote}
      disabled={disabled}
      onChange={(event) => {
        onChange({ ...statement, quote: event.target.value });
      }}
    />
  </li>
);

/** A source's statements, each editable, and a way to add one. */
export const StatementsEditor = ({
  statements,
  disabled,
  onChange,
}: {
  statements: DraftStatement[];
  disabled: boolean;
  onChange: (statements: DraftStatement[]) => void;
}) => (
  <section aria-label="Statements" className="flex flex-col gap-2">
    <h3 className="font-medium">Statements</h3>
    {statements.length === 0 ? (
      <p className="text-muted-foreground text-sm">No statements yet.</p>
    ) : (
      <ol className="flex flex-col gap-2">
        {statements.map((statement, index) => (
          <StatementRow
            key={index}
            statement={statement}
            position={index + 1}
            disabled={disabled}
            onChange={(changed) => {
              onChange(
                statements.map((each, at) => (at === index ? changed : each))
              );
            }}
            onRemove={() => {
              onChange(statements.filter((_each, at) => at !== index));
            }}
          />
        ))}
      </ol>
    )}
    <div>
      <Button
        variant="outline"
        disabled={disabled || statements.length >= statementsMax}
        onClick={() => {
          onChange([...statements, emptyStatement()]);
        }}
      >
        Add a statement
      </Button>
    </div>
  </section>
);
