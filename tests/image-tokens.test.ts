import { expect, test } from "bun:test";
import { dropImageToken, inlinePaths, insertImageToken, replyParts } from "@shared/image-tokens";

const A = "/there/a.png";
const B = "/there/b.png";

test("a reply splits at each token, the image where its token was", () => {
  expect(replyParts("so sánh [Image #1] với [Image #2] nhé", [A, B])).toEqual([
    { text: "so sánh " }, { image: A }, { text: " với " }, { image: B }, { text: " nhé" },
  ]);
});

test("an image no token names leads the reply; a token naming nothing stays words", () => {
  expect(replyParts("xem [Image #3] này", [A])).toEqual([{ image: A }, { text: "xem [Image #3] này" }]);
});

test("one string for a single-paste backend: each path where its token was", () => {
  expect(inlinePaths("so sánh [Image #1] với [Image #2]", [A, B])).toBe(`so sánh ${A} với ${B}`);
  expect(inlinePaths("bên trái", [A])).toBe(`${A} bên trái`);
  expect(inlinePaths("không có ảnh", [])).toBe("không có ảnh");
});

test("a token goes in at the caret, spaced from the words either side", () => {
  expect(insertImageToken("compare this with that", 12, 1)).toEqual({ text: "compare this [Image #1] with that", caret: 23 });
  expect(insertImageToken("", 0, 1)).toEqual({ text: "[Image #1] ", caret: 11 });
  expect(insertImageToken("end", 3, 2)).toEqual({ text: "end [Image #2] ", caret: 15 });
});

test("removing a token leaves no double space and counts later tokens down", () => {
  expect(dropImageToken("a [Image #1] b [Image #2] c", 1)).toBe("a b [Image #1] c");
  expect(dropImageToken("[Image #1] [Image #2] ", 1)).toBe("[Image #1] ");
  expect(dropImageToken("x [Image #1]", 1)).toBe("x");
  expect(dropImageToken("ab[Image #1]cd", 1)).toBe("abcd");
});
