import { expect, test } from "bun:test";
import { optionButtonsFor } from "@web/components/AgentDetail";

test("renders one button per option, in the agent's order", () => {
  const opts = optionButtonsFor({
    question: "Proceed?", raw: "",
    options: [
      { key: "1", label: "Yes", selected: true },
      { key: "2", label: "Yes, and always allow access to project/", selected: false },
      { key: "3", label: "No", selected: false },
    ],
  });
  expect(opts.map((o) => o.key)).toEqual(["1", "2", "3"]);
});

// The rule the whole design rests on.
test("labels pass through verbatim — never shortened or reworded", () => {
  const long = "Yes, and always allow access to project/ from this project";
  const opts = optionButtonsFor({
    question: null, raw: "",
    options: [{ key: "1", label: long, selected: false }, { key: "2", label: "No", selected: false }],
  });
  expect(opts[0]!.label).toBe(long);
});

test("no options means no buttons, so the free-text path is the only one offered", () => {
  expect(optionButtonsFor({ question: null, options: null, raw: "some output" })).toEqual([]);
});
