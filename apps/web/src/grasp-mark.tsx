import type { ComponentProps } from "react";

/**
 * The Grasp mark, from the prototype (grasplabs/prototype
 * `packages/grasp/src/components/grasp-mark.tsx`). It takes the text colour,
 * so a token on the element around it colours it. Decorative: the name
 * beside it says what it is.
 */
export const GraspMark = (props: ComponentProps<"svg">) => (
  <svg
    fill="none"
    viewBox="0 0 82 68"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    {...props}
  >
    <path d="M15.99 0L13.72 12.51H74.32L76.58 0H15.99Z" fill="currentColor" />
    <path
      d="M42.21 18.42H5.59L3.33 30.93H39.94L42.21 18.42Z"
      fill="currentColor"
    />
    <path
      d="M38.88 36.85H2.26L0 49.36H36.61L38.88 36.85Z"
      fill="currentColor"
    />
    <path
      d="M48.84 18.42L43.23 49.44H56.14L59.48 30.93H66.07L61.67 55.29H5.98L3.73 67.79H72.31L81.24 18.42H48.84Z"
      fill="currentColor"
    />
  </svg>
);
