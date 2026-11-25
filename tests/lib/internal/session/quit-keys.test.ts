/** Which of the person's keys quits pi, as they bound it. */
import { describe, expect, it } from "vitest";
import { KEY_QUITS } from "../../../../lib/internal/session/quit-asker.ts";
import {
	DOUBLE_CLEAR_MS,
	type KeyMatcher,
	keyQuit,
} from "../../../../lib/internal/session/quit-keys.ts";

const ENTER = "\r";

/** Keys as a person might rebind them: exit on ctrl+q, clear on ctrl+x. */
const rebound: KeyMatcher = (data, name) =>
	(name === "app.exit" && data === "\x11") ||
	(name === "app.clear" && data === "\x18");
const EXIT = "\x11";
const CLEAR = "\x18";

describe("keyQuit", () => {
	const at = (data: string, editorText: string, atMs: number) => ({
		data,
		editorText,
		atMs,
	});

	it("reads the exit key on an empty editor as the person's, as they bound it", () => {
		const read = keyQuit(rebound);
		expect(read(at(EXIT, "", 0))).toBe(KEY_QUITS.exit);
		expect(read(at("\x04", "", 0)), "ctrl+d, bound to nothing here").toBe("");
	});

	it("reads the exit key over text as no quit, since pi deletes a character there", () => {
		expect(keyQuit(rebound)(at(EXIT, "half a thought", 0))).toBe("");
	});

	it("reads only a second clear key soon after the first as a quit", () => {
		const read = keyQuit(rebound);
		expect(read(at(CLEAR, "draft", 0)), "the first clears").toBe("");
		expect(read(at(CLEAR, "", DOUBLE_CLEAR_MS))).toBe(KEY_QUITS.clear);
		expect(read(at(CLEAR, "", 5_000)), "a third starts again").toBe("");
		expect(read(at(CLEAR, "", 5_000 + DOUBLE_CLEAR_MS + 1))).toBe("");
	});

	it("reads enter on /quit, or a start autocomplete finishes, as the person's", () => {
		const read = keyQuit(rebound);
		expect(read(at(ENTER, " /quit ", 0))).toBe(KEY_QUITS.command);
		expect(read(at(ENTER, "/qu", 0))).toBe(KEY_QUITS.command);
		expect(read(at(ENTER, "/quiet please", 0))).toBe("");
		expect(read(at(ENTER, "/", 0))).toBe("");
	});

	it("reads an ordinary key as no quit, and a key release as nothing", () => {
		const read = keyQuit(rebound);
		expect(read(at("q", "", 0))).toBe("");
		expect(read(at("\x1b[113;1:3u", "", 0))).toBeUndefined();
	});
});
