/**
 * The quiet "app" label on an agent that comes from the herdr app rather than
 * a terminal. Plain dim text: it says where the agent lives, it does not
 * compete with the state beside it. Terminal herdr agents carry no mark.
 */
export function OriginMark() {
  return <span className="origin-mark">app</span>;
}
