/**
 * One English plural, formed in one place.
 *
 * Not i18n and not pretending to be: paddock's UI is English. This exists so a
 * count and its noun cannot disagree — the defect it replaced was a space row
 * reading "1 tabs".
 *
 * IT LIVES HERE, not in a component, because "one place" was not true. The
 * helper sat in `RowActions.tsx` and only `RowActions.tsx` used it, while four
 * other sites spelled the rule out again and got it wrong: `SpaceRow` and
 * `SpacePicker` announced "1 panes" to a screen reader, and `PaneTerminal`
 * showed "· 1 lines" and "· 1 gaps" to everyone. A shared string rule kept in
 * a component is a rule the next component will not find.
 */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
