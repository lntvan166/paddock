/** Compact elapsed label. Answers "is this stuck?" better than a timestamp. */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  // ROUNDED at the hour and day scales, floored below them.
  //
  // Flooring here threw away most of a unit: an agent idle for 1h51m read as
  // "1h", which understates staleness — and understating is the wrong direction
  // for a label whose whole job is answering "has this been sitting too long?".
  // Minutes stay floored because a minute is fine-grained enough that rounding
  // buys nothing, and because `now` already covers everything under one.
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * The label an operator actually reads, which has to say how much paddock
 * knows.
 *
 * herdr's `agent.list` carries no timestamp — `state_change_seq` and `revision`
 * are sequence numbers, not clocks — so an agent paddock meets for the first
 * time has an age paddock cannot know, and `toAgent` stamps first sight as the
 * only defensible floor. Rendering that as a plain age was a screen telling the
 * operator something false: on a live instance, five agents idle for days all
 * read "1h", sharing one `stateSince` to the millisecond, because that was
 * paddock's own uptime.
 *
 * `+` means "at least". It appears until paddock witnesses a transition, after
 * which the number is real and the mark goes away by itself.
 *
 * Not applied to `now`: under a minute of watching says nothing either way, and
 * "now+" reads as a rendering fault rather than as a bound.
 */
export function elapsedLabel(ms: number, exact: boolean): string {
  const label = formatElapsed(ms);
  return exact || label === "now" ? label : `${label}+`;
}
