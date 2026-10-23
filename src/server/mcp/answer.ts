import { parseAskDialog } from "@server/herdr/ask-dialog";
import { toggleDialogOption, typeIntoFreeText, type DialogIo } from "@server/herdr/dialog-type";
import { MAX_TYPE_CHARS } from "@server/limits";
import { describeBlocked, isQuestionDialog } from "@server/mcp/blocked";
import type { ToolResult } from "@server/mcp/protocol";
import type { AgentStore } from "@server/state/store";

export class QuestionOnlyError extends Error {}

/**
 * A `DialogIo` that refuses to see anything but a question dialog.
 *
 * The helpers below read the screen themselves between keys, and
 * `a digit or an Enter answers a PERMISSION prompt just as readily as a question.
 * Checking once up front would leave every later read unguarded, so a prompt
 * that replaced the dialog mid-call would be answered by the next Enter. With
 * every read classified, that read throws and no further key goes out.
 */
export function questionOnlyIo(io: DialogIo): DialogIo {
  return {
    ...io,
    async readPromptScreen(target) {
      const screen = await io.readPromptScreen(target);
      if (!isQuestionDialog(screen)) throw new QuestionOnlyError("not a question dialog");
      return screen;
    },
  };
}

const refuse = (error: string): ToolResult => ({ ok: false, error });

/**
 * Answer the question dialog on `id`'s screen, by label or with free text.
 *
 * The bridge's ONLY path to a blocked agent, and only for a question the agent
 * asked: `parseAskDialog` must recognise the screen on every read, so a
 * permission prompt is never answered from here.
 */
export async function answerQuestion(
  store: AgentStore, id: string, input: { option?: unknown; text?: unknown }, io: DialogIo,
): Promise<ToolResult> {
  const agent = store.snapshot().find((a) => a.agentId === id);
  if (!agent) return refuse(`unknown agent: ${id}`);
  if (agent.state !== "blocked") return refuse(`agent is ${agent.state}; there is no question to answer`);
  const hasOption = input.option !== undefined;
  const hasText = input.text !== undefined;
  if (hasOption === hasText) return refuse("give exactly one of option or text");

  const guarded = questionOnlyIo(io);
  try {
    const screen = await io.readPromptScreen(id);
    const dialog = isQuestionDialog(screen) ? parseAskDialog(screen) : null;
    if (dialog === null) {
      return refuse("not a question dialog: only the operator can answer this prompt, in the paddock UI");
    }
    if (dialog.mode === "multi") return refuse("multi-select questions are answered in the paddock UI");

    if (hasOption) {
      if (typeof input.option !== "string") return refuse("option must be a string");
      const want = input.option.trim();
      const choices = dialog.options.filter((o) => !o.freeText);
      const matches = choices.filter((o) => o.label.trim() === want);
      if (matches.length !== 1) {
        const why = matches.length === 0 ? "no option is labelled" : "more than one option is labelled";
        return refuse(`${why} ${JSON.stringify(want)}; the options are: ${choices.map((o) => o.label).join(" / ")}`);
      }
      // The same helper `/dialog-key` uses: in this dialog a digit picks,
      // and it steps off the free-text row first, where a digit would be TEXT.
      // (`selectByCursor` is the permission-prompt path and cannot even see
      // these options — `parsePrompt` refuses the dialog, by decision 29.)
      const out = await toggleDialogOption(id, matches[0]!.key, guarded);
      if (!out.ok) return refuse(out.detail ?? "the option could not be picked; nothing was sent");
    } else {
      const text = input.text;
      const chars = typeof text === "string" ? [...text] : [];
      const printable = chars.every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      });
      if (typeof text !== "string" || text.trim() === "" || chars.length > MAX_TYPE_CHARS || !printable) {
        return refuse(`text must be printable, non-empty, and at most ${MAX_TYPE_CHARS} characters`);
      }
      const free = dialog.options.find((o) => o.freeText);
      if (!free) return refuse("this question has no free-text answer; pick an option instead");
      const typed = await typeIntoFreeText(id, chars, guarded);
      if (!typed.ok) return refuse(typed.detail ?? "the text could not be typed; nothing was committed");
      // Enter commits the row under the cursor, so prove it is still ours.
      await io.settle?.();
      const now = parseAskDialog(await guarded.readPromptScreen(id));
      if (now?.cursor?.kind !== "option" || now.cursor.key !== free.key) {
        return refuse("the cursor left the free-text row; the text was typed but not committed");
      }
      await io.sendNavKey(id, "enter");
    }
  } catch (err) {
    if (err instanceof QuestionOnlyError) {
      return refuse("the screen stopped being a question dialog; nothing further was sent");
    }
    throw err;
  }

  await io.settle?.();
  const after = await io.readPromptScreen(id);
  // Null: the dialog closed, or became something else. read_agent says which.
  const next = isQuestionDialog(after) ? describeBlocked(after) : null;
  return { ok: true, data: { answered: true, next } };
}
