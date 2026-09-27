// Compile-time guarantees of the screen SDK. This file is type-checked by
// `vp check` and never run.
//
// Screens' type check sees only the kit's packages, not
// `@grasp-os/shared`, so the SDK states a run's shape itself: what core
// answers must fit what screens are told they get.
import type { DecisionAnswerInput } from "@grasp-os/shared/decisions";
import type {
  ScreenRun as CoreScreenRun,
  WaitingDecision as CoreWaitingDecision,
} from "@grasp-os/shared/screens";
import type {
  RunStatus as CoreRunStatus,
  WorkflowRun as CoreWorkflowRun,
} from "@grasp-os/shared/workflows";
import { expectTypeOf } from "vite-plus/test";

import type {
  DecisionAnswer,
  RunStatus,
  ScreenRun,
  WaitingDecision,
  WorkflowRun,
} from "../src/screen.ts";

expectTypeOf<RunStatus>().toEqualTypeOf<CoreRunStatus>();
expectTypeOf<CoreWaitingDecision>().toEqualTypeOf<WaitingDecision>();
expectTypeOf<CoreWorkflowRun>().toExtend<WorkflowRun>();
expectTypeOf<CoreScreenRun>().toExtend<ScreenRun>();
// A screen can send every answer core takes, and only those.
expectTypeOf<DecisionAnswer>().toEqualTypeOf<DecisionAnswerInput>();
