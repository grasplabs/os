/**
 * The root object core exposes to the frontend over Cap'n Web, at `/rpc`.
 * Core implements it; the frontend holds a typed stub of it.
 */
export interface CoreApi {
  /** Answers `"pong"`: proves the connection works end to end. */
  ping: () => "pong";
}
