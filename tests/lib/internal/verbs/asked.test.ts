/**
 * What pi-verbs is asked, read from its words before it looks for its
 * socket, so help and a wrong asking answer anywhere.
 */

import { describe, expect, it } from "vitest";
import {
	VERBS_HELP,
	verbsAsked,
} from "../../../../lib/internal/verbs/asked.ts";

describe("what pi-verbs is asked", () => {
	it("answers help first, opening with its name, within 72 columns", () => {
		expect(verbsAsked(["--help"])).toEqual({ help: true });
		expect(verbsAsked(["-h"])).toEqual({ help: true });
		expect(verbsAsked(["list", "--help"])).toEqual({ help: true });
		expect(VERBS_HELP.startsWith("pi-verbs "), VERBS_HELP).toBe(true);
		const wide = VERBS_HELP.split("\n").filter((line) => line.length > 72);
		expect(wide, "lines past 72 columns").toEqual([]);
	});

	it("reads each command's words", () => {
		expect(verbsAsked(["serve"])).toEqual({ serve: true });
		expect(verbsAsked(["list"])).toEqual({ line: { ask: "watch" } });
		expect(verbsAsked(["told", "u1", "accepted"])).toEqual({
			line: { ask: "told", use: "u1", outcome: "accepted" },
		});
		expect(verbsAsked(["ask", "explain", "tone=plain"])).toEqual({
			line: { ask: "verb", verb: "explain", args: { tone: "plain" } },
			selection: true,
		});
	});

	it("names the nearest command to one it doesn't know", () => {
		expect(verbsAsked(["lst"])).toEqual({
			wrong: "pi-verbs has no command lst; did you mean list?",
		});
		expect(verbsAsked(["--frob"])).toEqual({
			wrong: "pi-verbs has no command --frob",
		});
		expect(verbsAsked([])).toEqual({ wrong: "pi-verbs wants a command" });
		expect(verbsAsked(["toString"])).toEqual({
			wrong: "pi-verbs has no command toString",
		});
	});

	it("says a known command's own usage when its words are wrong", () => {
		expect(verbsAsked(["told", "u1"])).toEqual({
			wrong: "usage: pi-verbs told USE accepted|undone|dismissed",
		});
		expect(verbsAsked(["ask"])).toEqual({
			wrong: "usage: pi-verbs ask VERB [NAME=WORDS ...] < selection",
		});
		expect(verbsAsked(["ask", "explain", "plain"])).toEqual({
			wrong: "usage: pi-verbs ask VERB [NAME=WORDS ...] < selection",
		});
		expect(verbsAsked(["list", "x"])).toEqual({
			wrong: "usage: pi-verbs list",
		});
	});
});
