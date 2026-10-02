import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@grasp-os/ui/components/input-group";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { useLingui } from "@lingui/react/macro";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";

import { ErrorText } from "../error-text.tsx";

// Where a question is written, in the prototype's look
// (grasplabs/prototype `components/chat/chat-composer.tsx`): a box that
// grows with what is typed, the model that answers below it on the left,
// and send, or stop while Grasp answers, on the right. Enter sends;
// Shift+Enter starts a new line. The models are core's: no keys or
// providers are set here.

/** How a model is named in the box: the last part of its ID. */
export const modelName = (model: string): string =>
  model.split("/").at(-1) ?? model;

/** Which model answers the next question. */
const ModelPicker = ({
  models,
  model,
  onModel,
}: {
  models: readonly string[];
  model: string;
  onModel: (model: string) => void;
}) => {
  const { t } = useLingui();
  const name = modelName(model);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Model: ${name}. Change model`}
        render={<InputGroupButton size="sm" variant="ghost" />}
      >
        <SparklesIcon className="text-status-attention" />
        <span className="max-w-48 truncate">{name}</span>
        <ChevronDownIcon className="text-muted-foreground size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t`Models for your organization`}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value: unknown) => {
              if (typeof value === "string") {
                onModel(value);
              }
            }}
            value={model}
          >
            {models.map((each, index) => (
              <DropdownMenuRadioItem key={each} value={each}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{modelName(each)}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {index === 0 ? t`The default, ${each}` : each}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The box to ask in. Controlled: the page keeps the text and the model. */
export const Composer = ({
  text,
  onText,
  models,
  model,
  onModel,
  running,
  busy,
  failure,
  onSend,
  onStop,
}: {
  text: string;
  onText: (text: string) => void;
  /** The models a question may name, the default first. */
  models: readonly string[];
  model: string;
  onModel: (model: string) => void;
  /** Whether Grasp is answering in this chat now. */
  running: boolean;
  /** Whether a question or a stop is on its way to core. */
  busy: boolean;
  failure?: string;
  onSend: () => void;
  onStop: () => void;
}) => {
  const { t } = useLingui();
  const empty = text.trim() === "";
  const canSend = !running && !busy && !empty && model !== "";
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          onSend();
        }
      }}
    >
      <InputGroup size="prompt">
        <InputGroupTextarea
          aria-label={t`Your question`}
          className="field-sizing-content max-h-48 min-h-16"
          name="message"
          onChange={(event) => {
            onText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={t`Ask anything, or describe a process`}
          value={text}
        />
        <InputGroupAddon align="block-end">
          <div className="flex w-full items-center justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              {models.length === 0 ? null : (
                <ModelPicker model={model} models={models} onModel={onModel} />
              )}
            </div>
            {running ? (
              <InputGroupButton
                aria-label={t({ message: "Stop", context: "stop the answer" })}
                disabled={busy}
                onClick={onStop}
                size="icon-sm"
                type="button"
                variant="default"
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                aria-label={t({
                  message: "Send",
                  context: "send the question",
                })}
                disabled={!canSend}
                size="icon-sm"
                type="submit"
                variant={canSend ? "default" : "secondary"}
              >
                {busy ? <Spinner /> : <ArrowUpIcon />}
              </InputGroupButton>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
      {models.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">
          {t`No model is set up for this deployment yet.`}
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};
