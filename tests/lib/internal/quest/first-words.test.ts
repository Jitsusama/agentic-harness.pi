import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FIRST_WORDS_FOR_MS,
	leaveFirstWords,
	spawnedWords,
	takeFirstWords,
} from "../../../../lib/internal/quest/first-words";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "first-words-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("a spawned session's first words", () => {
	it("are taken once, by the key they were left under", () => {
		leaveFirstWords("019a-new", "carry on", dir);
		expect(takeFirstWords(["019a-new"], dir)).toBe("carry on");
		expect(takeFirstWords(["019a-new"], dir)).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("are found under the environment's token or the session's own id", () => {
		leaveFirstWords("019a-own", "by id", dir);
		expect(takeFirstWords([undefined, "019a-own"], dir)).toBe("by id");
		leaveFirstWords("token-1", "by token", dir);
		expect(takeFirstWords(["token-1", "019a-own"], dir)).toBe("by token");
	});

	it("are dropped once they've waited too long", () => {
		const then = Date.now() - FIRST_WORDS_FOR_MS - 1000;
		leaveFirstWords("019a-late", "stale", dir, then);
		expect(takeFirstWords(["019a-late"], dir)).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
	});

	it("tell nothing when the file isn't words a spawn left", () => {
		writeFileSync(join(dir, "019a-bad.json"), "{not json");
		expect(takeFirstWords(["019a-bad"], dir)).toBeUndefined();
	});

	it("are never read or left under a key that could leave the folder", () => {
		expect(() => leaveFirstWords("../escape", "no", dir)).toThrow(
			/not a session key/,
		);
		expect(takeFirstWords(["../escape"], dir)).toBeUndefined();
	});

	it("say to carry on with the quest, and what the spawn gave as its spec", () => {
		expect(spawnedWords("QEST-1")).toMatch(
			/^\[Automated message, no human input: quest spawn started this session on QEST-1\.\] Carry on with QEST-1/,
		);
		expect(spawnedWords("QEST-1", "  ")).not.toContain("started for");
		expect(spawnedWords("QEST-1", "build it")).toMatch(
			/What it was started for:\n\nbuild it$/,
		);
	});
});
