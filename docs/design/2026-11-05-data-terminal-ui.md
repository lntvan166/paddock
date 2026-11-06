# The data-terminal UI

Status: shipped on `feat/data-terminal-ui`. Amends §6 "Visual style" of
`2026-08-17-paddock-design.md` and the palette in
`2026-08-24-ui-primitives-design.md`.

## Why

An audit of the browser demo with the taste-skill inspector (app-screen
rules) found four failures and three warnings. The failures were uppercase,
letter-spaced section eyebrows, the `✕` dingbat, a rust accent read as the
stock "assistant" palette, and a panel shadow heavy enough to float. The
warnings were two `h1`s, a void in the first screen, and icons in tinted
squares. Beyond the meter, the screens spent red on whole bands, put a state
only on a 7px dot in a tile's corner, and kept the answer to a blocked agent
one screen away from the list.

Three styles were dealt (data terminal, framed sheet, achromatic ledger), and
seven were compared on the demo data. **Data terminal** was chosen: a
monitoring screen read in long sessions, where every selection is the same
thin accent line and colour lives on data and state.

## Amendment (2026-11-06): the rust accent stays

On review, the operator found the blue build monotone next to the old one and
kept paddock's rust: `#b4542e` light, `#e08a63` dark with a near-black label.
The accent marks selection AND fills the primary actions again: Send, the
create dial, a switched-on toggle (shadcn `--primary`), the selected segment,
the current tab's label. Links and Back stay ink. The taste-skill inspector's
`palette-terracotta` check is overridden for this token, by the operator's
choice. Everything below about blue describes the first pass.

## What changed

**Palette.** Light: page `#f6f6f7`, panels white, ink `#111113`, accent
`#1f5fae`. Dark: page `#171719`, panels one step darker (`#131217`), accent
`#5b98e0` with a near-black label. Two new line steps around `--border`:
`--rule` (rows inside a panel) and `--control` (a button, field or option
edge). The swap matters: `--surface` is now the panel and fields sit on it
with a `--control` edge. `--bg` is only the page. AA is asserted per theme by
`tests/themes.test.ts`, which now requires `--rule` and `--control` of every
named theme.

**The accent marks selection only.** It appears on the open tab (a line on
the tab bar's edge), the open panel toggles in the terminal, the selected
member of a segmented control, a selected question-dialog option, and the
agent open beside the list. Every action and link that borrowed it is ink
now: the create dial, Back, row actions, the update bar, and shadcn's
`--primary`. A state never uses it.

**Red once per agent.** Lists are panels on the gutter (`.sec-panel`,
`.agent-card`), with content one step in (`--pad-panel`). The blocked card
lost its wash and its 2px edge. The state is a dot plus a word
(`ui/StateWord.tsx`) in the row's trailing column, and the terminal header
uses the same word instead of the uppercase pill.

**Type.** Section and band labels are sentence case at `--t-md`. The scale
is unchanged (11/13/15/17 already matched the style's dense body). Figures
are tabular everywhere. System fonts only: the style's webfont was refused by
the existing rule.

**The dashboard leads with a sentence.** The band's title is the noun
"Agents" with the mark, and the host moved to a chip. Under the band,
`Finding` names the agent that most needs a person and how long it has
waited. When nothing needs anyone, it falls back to the counts.

**A blocked agent is answered from its card** (`CardPrompt.tsx`). It uses
the terminal's own rules. Buttons appear only for a parsed permission prompt
answered by digit. A question dialog, a recognised dialog or an unparsed
prompt gets only "Open terminal". Labels and digits are the agent's own, the
cursor is a plain drawn chevron and never the accent, and the persistent
grant is tagged. The prompt is re-read on every state change. A refusal is
said on the card.

**Wide screens** (`WIDE_QUERY`, 70rem, in `src/web/layout.ts` and the
matching `@media` block). The tab bar becomes a left rail, and opening an
agent keeps the list in a fixed column beside the terminal. The split is
rendered only when the width query matches, so a phone never mounts the list
behind a terminal.

**Drawn glyphs** replace `✕` and `❯` (`CloseIcon`, `CursorIcon`), because
both are dingbats some platforms paint as emoji.

## Declined, and why

- **A live tail under each row** (the last line of each pane). Getting it
  means reading every agent's screen on a timer. A TUI's last line is
  usually its status bar or input box, and pulling out the meaningful
  spinner line is harness-specific parsing: guessing at content, which
  CLAUDE.md's "never guess" rule exists to stop. The task line (the terminal
  title) already says what an agent is doing.
- **Search on Spaces and a pane preview on a space.** Search is not worth
  the space with a handful of spaces. A preview needs a screen read per
  pane.

## Measured

taste-skill `inspect.mjs --app` against `paddock serve --demo`, before → after:
4 FAIL, 3 WARN → 0 FAIL, 2 WARN. The two that remain are defended:

- `many-h1`: the pager mounts all three tab screens at once, so Settings'
  `h1` is in the DOM beside Agents'.
- `icon-chips`: the harness tile is the agent's identity (which runtime is
  asking), not a decorative icon box.
