// Grasp in the chat: the buddy's eyes on a dark tile, beside each answer
// (grasplabs/prototype `components/chat/grasp-eyes.tsx`). They show what it
// is doing: scanning while it reads, looking up while it thinks, following
// the line while it writes, squinting while it runs code, and a double
// blink when it is done. Only the newest answer's eyes move (`live`).
// Decorative: the answer itself says what happened. The look lives in the
// `eyes-*` utilities in styles.css.

/** What Grasp is doing, as its eyes show it. */
export type EyesState =
  | "idle"
  | "reading"
  | "thinking"
  | "writing"
  | "working"
  | "error";

export const GraspEyes = ({
  state,
  live,
}: {
  state: EyesState;
  live: boolean;
}) => (
  <span
    aria-hidden="true"
    className="eyes size-5"
    data-eyes={state}
    data-live={live ? "" : undefined}
  >
    <span className="eyes-pair">
      <span className="eyes-eye eyes-eye-left" />
      <span className="eyes-eye eyes-eye-right" />
    </span>
  </span>
);
