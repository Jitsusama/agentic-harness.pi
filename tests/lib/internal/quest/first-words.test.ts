import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FIRST_WORDS_FOR_MS,
	firstTurnOf,
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

	it("clear away records of takings nobody looked for in time", () => {
		const stale = join(dir, "token-old.taken");
		const fresh = join(dir, "token-new.taken");
		writeFileSync(stale, "{}");
		writeFileSync(fresh, "{}");
		const then = (Date.now() - FIRST_WORDS_FOR_MS - 1000) / 1000;
		utimesSync(stale, then, then);
		leaveFirstWords("token-2", "carry on", dir);
		expect(readdirSync(dir).sort()).toEqual([
			"token-2.json",
			"token-new.taken",
		]);
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

describe("whether a spawned session took its first turn", () => {
	let sessions: string;
	beforeEach(() => {
		sessions = join(dir, "sessions");
		mkdirSync(join(sessions, "--home--"), { recursive: true });
	});

	/** A session log pi wrote for `id`, holding `entries`. */
	function logOf(id: string, entries: object[]): void {
		writeFileSync(
			join(sessions, "--home--", `2026-11-04T12-00-00-000Z_${id}.jsonl`),
			[{ type: "session", id }, ...entries]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
	}
	const userSaid = {
		type: "message",
		// Said after any spawn or taking these tests make.
		timestamp: new Date(Date.now() + 3_600_000).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "carry on" }] },
	};

	it("says it did once its log holds the turn its words started", () => {
		leaveFirstWords("token-1", "carry on", dir);
		takeFirstWords(["token-1", "019a-new"], dir, Date.now(), {
			sessionId: "019a-new",
			said: true,
		});
		logOf("019a-new", [userSaid]);
		expect(firstTurnOf("token-1", { dir, sessions })).toEqual({
			started: true,
			sessionId: "019a-new",
		});
	});

	it("says no session took the words a spawn left waiting", () => {
		leaveFirstWords("token-1", "carry on", dir);
		expect(
			firstTurnOf("token-1", { dir, sessions, sessionId: "019a-handed" }),
		).toEqual({
			started: false,
			sessionId: "019a-handed",
			found: expect.stringMatching(/no session has taken the first words/),
		});
	});

	it("says a session took its words but has no log, so no turn", () => {
		leaveFirstWords("token-1", "carry on", dir);
		takeFirstWords(["token-1"], dir, Date.now(), {
			sessionId: "019a-mute",
			said: true,
		});
		expect(firstTurnOf("token-1", { dir, sessions })).toEqual({
			started: false,
			sessionId: "019a-mute",
			found: expect.stringMatching(/took its first words .* no session log/),
		});
	});

	it("says when a session put its words off for a prompt that never ran", () => {
		leaveFirstWords("token-1", "carry on", dir);
		takeFirstWords(["token-1"], dir, Date.now(), {
			sessionId: "019a-waits",
			said: false,
		});
		logOf("019a-waits", [{ type: "model_change" }]);
		expect(firstTurnOf("token-1", { dir, sessions })).toEqual({
			started: false,
			sessionId: "019a-waits",
			found: expect.stringMatching(/put them off .* holds no turn/),
		});
	});

	it("counts no turn a resumed session took before its spawn", () => {
		const spawnedAt = Date.now();
		leaveFirstWords("token-1", "carry on", dir, spawnedAt);
		takeFirstWords(["token-1"], dir, spawnedAt, {
			sessionId: "019a-resumed",
			said: true,
		});
		logOf("019a-resumed", [
			{
				...userSaid,
				timestamp: new Date(spawnedAt - 3_600_000).toISOString(),
			},
		]);
		expect(firstTurnOf("token-1", { dir, sessions, since: spawnedAt })).toEqual(
			{
				started: false,
				sessionId: "019a-resumed",
				found: expect.stringMatching(/said them, but its log holds no turn/),
			},
		);
	});

	it("is asked once: the record of a taking goes with the answer", () => {
		leaveFirstWords("token-1", "carry on", dir);
		takeFirstWords(["token-1"], dir, Date.now(), {
			sessionId: "019a-new",
			said: true,
		});
		logOf("019a-new", [userSaid]);
		firstTurnOf("token-1", { dir, sessions });
		expect(readdirSync(dir)).toEqual(["sessions"]);
	});
});
