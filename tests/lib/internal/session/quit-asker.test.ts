/** Who asked a plain pi to quit, as its crash record reads it, and what a held one exits with. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASK_LASTS_MS,
	askQuit,
	DOUBLE_CLEAR_MS,
	KEY_QUITS,
	type KeyMatcher,
	keyQuit,
	quitAsker,
	quitExit,
	quitLine,
	takeBackQuit,
	UNASKED_EXIT,
	UNNAMED_QUIT,
} from "../../../../lib/internal/session/quit-asker.ts";

const ENTER = "\r";

/** Keys as a person might rebind them: exit on ctrl+q, clear on ctrl+x. */
const rebound: KeyMatcher = (data, name) =>
	(name === "app.exit" && data === "\x11") ||
	(name === "app.clear" && data === "\x18");
const EXIT = "\x11";
const CLEAR = "\x18";

afterEach(() => {
	takeBackQuit(quitAsker(Number.NEGATIVE_INFINITY) ?? "");
	askQuit("", 0, Number.NEGATIVE_INFINITY);
});

describe("quitAsker", () => {
	it("answers nobody when nobody asked", () => {
		expect(quitAsker()).toBeUndefined();
	});

	it("answers the latest caller that named itself", () => {
		askQuit("the mesh, closing", ASK_LASTS_MS, 1_000);
		askQuit("the quest, ended", ASK_LASTS_MS, 1_500);

		expect(quitAsker(2_000)).toBe("the quest, ended");
	});

	it("forgets an ask once its span has passed, so it never names a later quit", () => {
		askQuit("the mesh, closing", ASK_LASTS_MS, 10_000);

		expect(quitAsker(10_000 + ASK_LASTS_MS - 1)).toBe("the mesh, closing");
		expect(quitAsker(10_000 + ASK_LASTS_MS + 1)).toBeUndefined();
	});

	it("takes back only its own ask, so a later caller's stands", () => {
		askQuit("the mesh, closing", ASK_LASTS_MS, 1_000);
		takeBackQuit("the mesh, closing");
		expect(quitAsker(1_001)).toBeUndefined();

		askQuit("the quest, ended", ASK_LASTS_MS, 1_000);
		takeBackQuit("the mesh, closing");
		expect(quitAsker(1_001)).toBe("the quest, ended");
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

describe("quitExit", () => {
	it("restarts a held pi nobody asked, which pi would end with 0", () => {
		expect(quitExit(undefined, true, 0)).toBe(UNASKED_EXIT);
		expect(quitExit(undefined, true, undefined)).toBe(UNASKED_EXIT);
	});

	it("keeps a quit someone asked for, and any pi no holder runs", () => {
		expect(quitExit("the person's /quit", true, 0)).toBe(0);
		expect(quitExit(undefined, false, 0)).toBe(0);
	});

	it("keeps a code another set, as a park's or one-writer's", () => {
		expect(quitExit(undefined, true, 75)).toBe(75);
		expect(quitExit(undefined, true, 78)).toBe(78);
	});
});

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

	it("keeps an asker's name to one line, so it writes no line of its own", () => {
		expect(quitLine("s1", "a steer\npi: forged", false)).toBe(
			"pi: quitting session s1, asked by a steer pi: forged",
		);
	});
});
