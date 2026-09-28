/** A time as the release pages show it: `YYYY-MM-DD HH:MM`, in UTC, the same on the server and in the browser. */
export const formatTime = (time: Date): string =>
  time.toISOString().slice(0, 16).replace("T", " ");

/** A byte count, in the largest unit that keeps it at or above one. */
export const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};
