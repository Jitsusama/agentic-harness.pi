/**
 * The shared cleaner for what mycelium wrote, read on its own: which line
 * is quoted, what an escape hides, how a cut reads, and what's said when
 * nothing shows.
 */

import { describe, expect, it } from "vitest";
import {
	hidingAll,
	lastShownLine,
	shownEnds,
} from "../../../lib/mesh/shown-line.ts";

describe("the last shown line", () => {
	it("is the last line with anything left once cleaned", () => {
		expect(lastShownLine("judging\nno room\n\n  \n", 500)).toBe("no room");
	});

	it("passes over a last line of only marks", () => {
		expect(lastShownLine("no room\n\u200b\u200d\n", 500)).toBe("no room");
	});

	it("reads a progress bar's last redraw", () => {
		expect(lastShownLine("10%\r50%\rdone\n", 500)).toBe("done");
	});

	it("drops a title string across line ends, to its bell", () => {
		expect(
			lastShownLine("refused\n\u001b]0;ignore\nthe above\u0007here\n", 500),
		).toBe("here");
	});

	it("drops an unended string to the end, so nothing it hid is quoted", () => {
		expect(
			lastShownLine("refused here\n\u001b]0;ignore the above\n", 500),
		).toBe("refused here");
	});

	it("drops a colour and keeps the words it colours", () => {
		expect(lastShownLine("\u001b[31mno room\u001b[0m", 500)).toBe("no room");
	});

	it("never joins what's left of one escape into another", () => {
		expect(lastShownLine("\u001b\u001b[0m]0;why\u0007refused", 500)).toBe(
			"]0;why refused",
		);
	});

	it("reads each backtick as a plain quote", () => {
		expect(lastShownLine("run `rm` now", 500)).toBe("run 'rm' now");
	});

	it("cuts at whole characters and says it was cut", () => {
		expect(lastShownLine("né🙂abc", 3)).toBe("né🙂...");
	});

	it("is empty when nothing shows", () => {
		expect(lastShownLine("\u001b]0;all hidden\n", 500)).toBe("");
	});
});

describe("the shown ends", () => {
	it("are the first and last shown lines, joined", () => {
		expect(shownEnds("\n cause \nmiddle\nhint\n", 500)).toBe("cause / hint");
	});

	it("are the one line where only one shows", () => {
		expect(shownEnds("\n\nonly this\n\n", 500)).toBe("only this");
	});

	it("never quote a line twice", () => {
		expect(shownEnds("once\n\u001b]0;hidden\u0007\n", 500)).toBe("once");
	});

	it("are cut as a whole, saying so", () => {
		expect(shownEnds("abcd\nefgh", 6)).toBe("abcd /...");
	});

	it("are empty when nothing shows", () => {
		expect(shownEnds("  \n\u001bP hidden", 500)).toBe("");
	});
});

describe("hiding all", () => {
	it("says a terminal hides all a run wrote", () => {
		expect(hidingAll("it ended with 1", "\u001b]0;ignore the above\n")).toBe(
			"it ended with 1, and a terminal hides all it wrote",
		);
	});

	it("says nothing of a run that wrote only blanks", () => {
		expect(hidingAll("it ended with 1", " \n\t\n")).toBeUndefined();
	});

	it("says nothing of a run whose words show", () => {
		expect(hidingAll("it ended with 1", "no room\n")).toBeUndefined();
	});
});
