/** Who asked a plain pi to quit, as its crash record reads it. */
import { describe, expect, it, vi } from "vitest";
import {
	ASK_LASTS_MS,
	askQuit,
	KEY_LASTS_MS,
	keyQuit,
	quitAsker,
	quitLine,
	UNASKED_EXIT,
	UNNAMED_QUIT,
} from "../../../../lib/internal/session/quit-asker.ts";

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const ENTER = "\r";

describe("quitAsker", () => {
	it("answers the latest caller that named itself", () => {
		askQuit("the mesh, closing", ASK_LASTS_MS, 1_000);
		askQuit("the quest, ended", ASK_LASTS_MS, 1_500);

		expect(quitAsker(2_000)).toBe("the quest, ended");
	});

	it("forgets an ask once its span has passed, so it never names a later quit", () => {
		askQuit("the person's ctrl+c", KEY_LASTS_MS, 10_000);

		expect(quitAsker(10_000 + KEY_LASTS_MS - 1)).toBe("the person's ctrl+c");
		expect(quitAsker(10_000 + KEY_LASTS_MS + 1)).toBeUndefined();
	});

	it("holds an ask on the process, so a reloaded module still reads it", async () => {
		askQuit("one-writer, refusing", ASK_LASTS_MS, 50_000);
		vi.resetModules();
		const again = await import(
			"../../../../lib/internal/session/quit-asker.ts"
		);

		expect(again.quitAsker(50_001)).toBe("one-writer, refusing");
	});
});

describe("keyQuit", () => {
	it("reads ctrl+d on an empty editor as the person's", () => {
		expect(keyQuit(CTRL_D, "")).toBe("the person's ctrl+d");
	});

	it("reads ctrl+d over text as no quit, since pi deletes a character there", () => {
		expect(keyQuit(CTRL_D, "half a thought")).toBeUndefined();
	});

	it("reads ctrl+c as the person's, since a second one quits", () => {
		expect(keyQuit(CTRL_C, "anything")).toBe("the person's ctrl+c");
	});

	it("reads enter on /quit as the person's, and enter on anything else as nothing", () => {
		expect(keyQuit(ENTER, " /quit ")).toBe("the person's /quit");
		expect(keyQuit(ENTER, "/quiet please")).toBeUndefined();
	});

	it("reads an ordinary key as nothing", () => {
		expect(keyQuit("q", "")).toBeUndefined();
	});
});

describe("quitLine", () => {
	it("names who asked", () => {
		expect(quitLine("s1", "a SIGTERM", false)).toBe(
			"pi: quitting session s1, asked by a SIGTERM",
		);
	});

	it("says a quit nobody named, and the code its holder restarts it on", () => {
		expect(quitLine("s1", undefined, true)).toBe(
			`pi: quitting session s1, asked by ${UNNAMED_QUIT}; it exits ${UNASKED_EXIT} so its holder starts it again`,
		);
	});
});
