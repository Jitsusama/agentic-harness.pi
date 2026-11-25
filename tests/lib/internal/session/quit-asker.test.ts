/** Who asked a plain pi to quit, as its crash record reads it, and what a held one exits with. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASK_LASTS_MS,
	askQuit,
	quitAsker,
	quitExit,
	quitLine,
	takeBackQuit,
	UNASKED_EXIT,
	UNNAMED_QUIT,
} from "../../../../lib/internal/session/quit-asker.ts";

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

	it("says a restart its holder couldn't be told the session of comes back new, and why", () => {
		expect(
			quitLine("s1", undefined, true, "it has no log\nto open"),
			"the why is kept to one line",
		).toBe(
			`pi: quitting session s1, asked by ${UNNAMED_QUIT}; it exits ${UNASKED_EXIT} so its holder starts it again, as a new conversation, since it has no log to open`,
		);
	});

	it("keeps an asker's name to one line, so it writes no line of its own", () => {
		expect(quitLine("s1", "a steer\npi: forged", false)).toBe(
			"pi: quitting session s1, asked by a steer pi: forged",
		);
	});
});
