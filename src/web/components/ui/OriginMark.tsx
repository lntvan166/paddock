/**
 * The quiet "app" label on an agent that comes from the herdr app rather than
 * a terminal. Plain dim text: it says where the agent lives, it does not
 * compete with the state beside it. Terminal herdr agents carry no mark.
 *
 * `machine` adds a second pill naming the machine the Herdr app added over
 * SSH, so with `agents.machines` at `all` another machine's agents read apart
 * from this one's. An agent on this machine carries no machine pill.
 */
export function OriginMark({ machine }: { machine?: string | null } = {}) {
  return (
    <>
      <span className="origin-mark">app</span>
      {machine ? <span className="origin-mark ident" data-machine={machine}>{machine}</span> : null}
    </>
  );
}
