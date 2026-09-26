/** Why something failed, announced to screen readers; nothing when it didn't. */
export const ErrorText = ({ children }: { children?: string }) =>
  children === undefined ? null : (
    <p className="text-destructive text-sm" role="alert">
      {children}
    </p>
  );
