import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FIRST_TURN_WATCH_MS,
	MOST_START_MS,
	piRunsFor,
	spawnedBy,
	stopFirstTurnWatches,
	watchFirstTurn,
} from "../../../extensions/quest-workflow/first-turn-watch";
import type { FirstTurn } from "../../../lib/internal/quest/first-words";

let said: { text: string; options: unknown }[];
let pi: ExtensionAPI;
let idle: boolean;
const ctx = { isIdle: () => idle } as unknown as ExtensionContext;

beforeEach(() => {
	vi.useFakeTimers();
	said = [];
	idle = true;
	pi = {
		sendUserMessage: (text: string, options?: unknown) => {
			said.push({ text, options });
		},
	} as unknown as ExtensionAPI;
});
afterEach(() => {
	stopFirstTurnWatches();
	vi.useRealTimers();
});

const spawned = { key: "token-1", questId: "QEST-1" };
const waiting: FirstTurn = {
	started: false,
	waiting: true,
	sessionId: "019a-slow",
	found: "no session has taken the first words the spawn left it",
};
const running = () => true;
const gone = () => false;

describe("a spawner watching for its session's first turn", () => {
	it("looks once, a minute after the spawn, and says nothing when it ran", () => {
		const asked: string[] = [];
		watchFirstTurn(pi, ctx, spawned, ({ key }) => {
			asked.push(key);
			return { started: true, sessionId: "019a-new" };
		});
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS - 1);
		expect(asked).toEqual([]);
		vi.advanceTimersByTime(1);
		vi.advanceTimersByTime(10 * FIRST_TURN_WATCH_MS);
		expect(asked).toEqual(["token-1"]);
		expect(said).toEqual([]);
	});

	it("counts only a turn taken since the spawn, so a resumed log's old turns don't", () => {
		const spawnedAt = Date.now();
		const since: number[] = [];
		watchFirstTurn(pi, ctx, spawned, (_spawned, after) => {
			since.push(after);
			return { started: true, sessionId: "019a-new" };
		});
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(since).toEqual([spawnedAt]);
	});

	it("starts its own turn naming the session, the quest and what it found", () => {
		const found: FirstTurn = {
			started: false,
			sessionId: "019a-mute",
			found: "it took its first words but has no session log",
		};
		watchFirstTurn(pi, ctx, spawned, () => found);
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(said).toHaveLength(1);
		const [told] = said;
		expect(told?.options).toBeUndefined();
		expect(told?.text).toMatch(/^\[Automated message, no human input: /);
		expect(told?.text).toContain("019a-mute");
		expect(told?.text).toContain("QEST-1");
		expect(told?.text).toContain(
			"it took its first words but has no session log",
		);
	});

	it("says it after a run already under way rather than cutting into it", () => {
		idle = false;
		watchFirstTurn(pi, ctx, spawned, () => ({
			started: false,
			found: "no session has taken the first words",
		}));
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(said[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(said[0]?.text).toContain("an id not yet known");
	});

	it("looks again while its words wait and its pi runs, saying nothing once it starts", () => {
		// 2026-11-04 17:05: a spawn's pi took 77 s to start at CPU pressure
		// 80%, and a look at 60 s told its spawner it never had.
		let looks = 0;
		watchFirstTurn(
			pi,
			ctx,
			spawned,
			() => {
				looks += 1;
				return looks < 2 ? waiting : { started: true, sessionId: "019a-slow" };
			},
			FIRST_TURN_WATCH_MS,
			running,
		);
		vi.advanceTimersByTime(MOST_START_MS * 2);
		expect(looks).toBe(2);
		expect(said).toEqual([]);
	});

	it("tells once its words have waited the longest a start may take, though its pi runs", () => {
		watchFirstTurn(
			pi,
			ctx,
			spawned,
			() => waiting,
			FIRST_TURN_WATCH_MS,
			running,
		);
		vi.advanceTimersByTime(MOST_START_MS - 1);
		expect(said).toEqual([]);
		vi.advanceTimersByTime(MOST_START_MS);
		expect(said).toHaveLength(1);
		expect(said[0]?.text).toContain(
			`${MOST_START_MS / 1000} s after the spawn`,
		);
	});

	it("tells at the first look when its words wait and no pi of it runs", () => {
		watchFirstTurn(pi, ctx, spawned, () => waiting, FIRST_TURN_WATCH_MS, gone);
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(said).toHaveLength(1);
		expect(said[0]?.text).toContain("60 s after the spawn");
	});

	it("reads the folder a spawn said waits to be trusted from its answer", () => {
		const details = {
			firstWordsKey: "token-1",
			autoloadQuestId: "QEST-1",
			trustWaits: "/trees/alpha",
		};

		expect(spawnedBy("spawn", details)).toEqual({
			key: "token-1",
			questId: "QEST-1",
			trustWaits: "/trees/alpha",
		});
	});

	it("tells at the first look, naming the folder, when its pi waits to be trusted", () => {
		// 11-07 20:20: a pi at the trust prompt runs and leaves its words
		// waiting, which the look took for a slow start for five minutes.
		watchFirstTurn(
			pi,
			ctx,
			{ ...spawned, trustWaits: "/trees/alpha" },
			() => waiting,
			FIRST_TURN_WATCH_MS,
			running,
		);
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(said).toHaveLength(1);
		expect(said[0]?.text).toContain(
			"Nothing had trusted /trees/alpha when it was spawned",
		);
	});

	it.runIf(existsSync("/proc/self/cmdline"))(
		"finds a running process by a word of its command line, and none by a word no process has",
		() => {
			const ownWord = process.argv[1] ?? "";
			expect(piRunsFor({ ...spawned, sessionId: ownWord })).toBe(true);
			expect(
				piRunsFor({ ...spawned, sessionId: "01a1ffff-no-such-session" }),
			).toBe(false);
			expect(piRunsFor(spawned)).toBe(false);
		},
	);

	it("looks no more once the session doing the watching ends", () => {
		const asked: string[] = [];
		watchFirstTurn(pi, ctx, spawned, ({ key }) => {
			asked.push(key);
			return { started: false, found: "nothing" };
		});
		stopFirstTurnWatches();
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(asked).toEqual([]);
		expect(said).toEqual([]);
	});
});
