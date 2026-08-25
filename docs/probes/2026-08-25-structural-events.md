# Probe: herdr structural event names (2026-08-25)

Spec §13 probe 4, Task 1. Measures, for the six structural events the
upcoming Spaces screen needs, the name herdr **accepts** on
`events.subscribe` and the name it actually **delivers** — before any code
subscribes to them. `src/server/herdr/socket.ts` already documents this trap
for the existing four pane events (subscribe `pane.agent_detected` delivers
`pane_agent_detected`, but `pane.agent_status_changed` stays dotted both
ways) — the underscore rule does not hold universally and had to be measured
again here rather than assumed.

## Method

herdr's brief for this task calls for a human to drive herdr by hand while a
probe script listens. That was replaced with a **self-contained** script:
one connection opens a long-lived `events.subscribe`, a second connection
issues `workspace.create` / `.rename` / `.close` and `tab.create` / `.rename`
/ `.close` against a throwaway workspace and tab it creates itself, and closes
**only** the ids herdr returned from its own create calls. `focus: false` on
every create so the operator's desktop focus was never stolen. No existing
workspace, tab, or pane was touched.

Server: `herdr status` showed `status: running`, `protocol: 20` on both
client and server before the probe ran.

Script (scratch, not committed): opened socket A, sent

```json
{"id":"probe-sub","method":"events.subscribe","params":{"subscriptions":[
  {"type":"workspace.created"},{"type":"workspace.closed"},{"type":"workspace.renamed"},
  {"type":"tab.created"},{"type":"tab.closed"},{"type":"tab.renamed"}
]}}
```

herdr's ack (one frame for the whole batch, not one per subscription):

```json
{"id":"probe-sub","result":{"type":"subscription_started"}}
```

No rejection for any of the six names — see "Rejections" below for the one
initially-misleading error this run also produced, which was a client bug,
not a subscribe rejection.

Then, on socket B, in order: `workspace.create` (`label: "paddock-probe"`),
`workspace.rename`, `tab.create` (in that workspace, `label:
"paddock-probe-tab"`), `tab.rename`, `tab.close`, `workspace.close`.

## Result: the six subscribe → deliver pairs

All six were **accepted** to subscribe, and all six were delivered
**underscored** — none of the four kept a dotted delivered form the way
`pane.agent_status_changed` does.

| # | Subscribed as | Accepted? | Delivered as | Evidence (this probe's own workspace/tab) |
|---|---|---|---|---|
| 1 | `workspace.created` | yes | `workspace_created` | `{"event":"workspace_created","data":{"type":"workspace_created","workspace":{"workspace_id":"w1S","label":"paddock-probe",...}}}` |
| 2 | `workspace.renamed` | yes | `workspace_renamed` | `{"event":"workspace_renamed","data":{"type":"workspace_renamed","workspace_id":"w1S","label":"paddock-probe-renamed"}}` |
| 3 | `workspace.closed` | yes | `workspace_closed` | `{"event":"workspace_closed","data":{"type":"workspace_closed","workspace_id":"w1S","workspace":{"label":"paddock-probe-renamed",...}}}` |
| 4 | `tab.created` | yes | `tab_created` | `{"event":"tab_created","data":{"type":"tab_created","tab":{"tab_id":"w1S:t2","workspace_id":"w1S","label":"paddock-probe-tab",...}}}` |
| 5 | `tab.renamed` | yes | `tab_renamed` | `{"event":"tab_renamed","data":{"type":"tab_renamed","tab_id":"w1S:t2","workspace_id":"w1S","label":"paddock-probe-tab-renamed"}}` |
| 6 | `tab.closed` | yes | `tab_closed` | `{"event":"tab_closed","data":{"type":"tab_closed","tab_id":"w1S:t2","workspace_id":"w1S"}}` |

Every delivered frame has the shape `{"id": null or absent, "event":
"<delivered_name>", "data": {"type": "<delivered_name>", ...}}` — the event
name is duplicated at `event` and inside `data.type`. `pane.*` handling in
`socket.ts` already matches on the top-level `event` field, so the six new
constants should follow the same pattern: match `event`, not `data.type`.

## Rejections

**None of the six names was rejected by `events.subscribe`.** All six
subscriptions were accepted in the single batched call and the ack came back
as one `subscription_started` frame, not six.

One `invalid_request` error did occur during this probe, but it was a
**client bug in the probe script**, not a subscribe rejection, and is
recorded here because it is itself a finding relevant to Task 7's adapter
code:

```json
{"id":"","error":{"code":"invalid_request","message":"invalid request: missing field `workspace_id` at line 1 column 116"}}
```

Cause: `workspace.create`'s result does **not** put `workspace_id` at the
top level. The full shape is:

```json
{"type":"workspace_created","workspace":{"workspace_id":"w1S","label":"paddock-probe",...},"tab":{...},"root_pane":{...}}
```

`workspace_id` is nested at `result.workspace.workspace_id`. The probe
script's first draft read `result.workspace_id` (undefined), sent
`workspace.rename` with no `workspace_id`, and herdr correctly rejected the
**request**, not the subscription. Fixed by reading
`result.workspace.workspace_id`. The equivalent trap exists for
`tab.create`: its result is `{"type":"tab_created","tab":{"tab_id":"w1S:t2",...},"root_pane":{...}}`
— `tab_id` is nested at `result.tab.tab_id`, not top-level, and (as the
brief already notes) `TabInfo` has no `pane_id` at all.

The leftover workspace this bug created (`w1R`, label `paddock-probe`) was
closed immediately via a one-off `workspace.close` call before the script
was fixed and re-run; see "Cleanup" below.

## Cleanup

`herdr workspace list` and `herdr tab list` were captured before the probe
and compared after. Before: 7 workspaces / 8 tabs, none named
`paddock-probe*`. After the corrected run (workspace `w1S` and tab
`w1S:t2`): 7 workspaces / 8 tabs, identical ids to the "before" snapshot —
`paddock-probe` / `paddock-probe-tab` and their renamed forms are gone. The
one leftover from the script-bug run (`w1R`) was closed by hand as soon as
it was discovered, before the corrected script ran again, so at no point
after the probe did an extra workspace or tab remain. No existing workspace,
tab, or pane's id, label, or content was read into this document or altered.

## Surprises

- **All six matched the "everything but the three pane exceptions is
  underscored" rule** — no new dotted survivor turned up among the six.
  Still worth having measured rather than assumed, per the brief.
- **The `events.subscribe` ack is one frame for the whole batch**, not one
  per subscribed type — a caller cannot use per-subscription ack failures to
  find out which of several names in one call was bad; a bad name would
  presumably need to show up as a top-level `error` on that single ack
  instead (not exercised here, since none of the six was bad).
- **The create-result nesting** (`workspace_id` under `.workspace`, `tab_id`
  under `.tab`) is not something either the brief or `socket.ts`'s existing
  comments call out, and it is exactly the kind of thing `adapter.ts` needs
  to get right in Task 7 — a naive `result.workspace_id` read fails loudly
  (herdr rejects the next call), but a naive `result.tab_id` read would fail
  **silently** if the caller doesn't immediately use it in a required field
  the way `workspace.rename` does.
