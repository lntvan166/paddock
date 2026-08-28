import { useState } from "react";
import { Card } from "@web/components/ui/Card";
import { Button } from "@web/components/shadcn/button";
import { FlashIcon } from "@web/components/ui/icons";
import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_LEN,
  readQuickReplies,
  writeQuickReplies,
} from "@web/prefs";

/**
 * The list behind the terminal's `Quick` panel.
 *
 * Owns its own state rather than taking `prefs`/`setPref`, because a list is
 * not a `Prefs` scalar — see `readQuickReplies` for why it needs JSON and its
 * own pair of functions. That keeps `writePref`'s type-keyed rule intact
 * instead of growing a special case for one field.
 *
 * NO SAVE BUTTON, matching every other "this device" setting on this screen:
 * each change writes immediately. There is nothing to batch and nothing that
 * can fail — it is one `localStorage` key.
 *
 * A refusal is SAID, never silent. Adding a duplicate or an over-long entry
 * would otherwise look like a button that did nothing, which is the same
 * complaint as a list that fails to appear.
 */
export function QuickRepliesSection() {
  const [replies, setReplies] = useState(readQuickReplies);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const text = draft.trim();
  const full = replies.length >= MAX_QUICK_REPLIES;
  // Disabled for the states an operator can SEE — nothing typed, or the list
  // already full. Duplicate and over-long stay enabled so tapping explains
  // itself rather than leaving a dead control with no reason given.
  const canAdd = text !== "" && !full;

  const commit = (next: string[]) => {
    setReplies(next);
    writeQuickReplies(next);
  };

  const add = () => {
    if (!canAdd) return;
    if (text.length > MAX_QUICK_REPLY_LEN) {
      setNote(`That is too long for a quick reply — ${MAX_QUICK_REPLY_LEN} characters at most.`);
      return;
    }
    if (replies.includes(text)) {
      setNote("That reply is already in the list.");
      return;
    }
    commit([...replies, text]);
    setDraft("");
    setNote(null);
  };

  return (
    <Card
      icon={<FlashIcon />}
      title="Quick replies"
      subtitle="One tap each, in an agent's terminal. Sent as written."
    >
      {replies.length === 0 ? (
        // Said out loud, because an empty list is a real choice here: the
        // terminal hides its Quick control entirely rather than offering an
        // empty panel, and an operator who cleared the list should be told
        // that is what they did.
        <p className="quick-reply-note" role="status">
          No quick replies. The Quick button is hidden in the terminal until you add one.
        </p>
      ) : (
        <ul className="quick-reply-list">
          {replies.map((reply) => (
            <li className="quick-reply-row" key={reply}>
              <span className="quick-reply-text">{reply}</span>
              <button
                type="button"
                className="quick-reply-remove"
                aria-label={`Remove ${reply}`}
                onClick={() => commit(replies.filter((r) => r !== reply))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="card-row quick-reply-new">
        <label className="sr-only" htmlFor="quick-reply-new">Add a quick reply</label>
        <input
          id="quick-reply-new"
          type="text"
          value={draft}
          maxLength={MAX_QUICK_REPLY_LEN + 1}
          placeholder={full ? `${MAX_QUICK_REPLIES} is the limit` : "Go ahead"}
          onChange={(e) => { setDraft(e.target.value); setNote(null); }}
          // Enter adds, because typing a short phrase and reaching for a button
          // is the slower half of this on a phone.
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <Button
          type="button"
          className="quick-reply-add"
          disabled={!canAdd}
          onPointerDown={(e) => { e.preventDefault(); }}
          onClick={add}
        >
          Add
        </Button>
      </div>

      {note !== null && (
        <p className="quick-reply-note" role="status">{note}</p>
      )}

      <p className="card-note">
        {replies.length} of {MAX_QUICK_REPLIES}. Kept on this device, like the theme.
      </p>
    </Card>
  );
}
