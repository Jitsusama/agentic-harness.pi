import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FIRST_TURN_WATCH_MS,
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

describe("a spawner watching for its session's first turn", () => {
	it("looks once, a minute after the spawn, and says nothing when it ran", () => {
		const asked: string[] = [];
		watchFirstTurn(pi, ctx, spawned, (key) => {
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

	it("looks no more once the session doing the watching ends", () => {
		const asked: string[] = [];
		watchFirstTurn(pi, ctx, spawned, (key) => {
			asked.push(key);
			return { started: false, found: "nothing" };
		});
		stopFirstTurnWatches();
		vi.advanceTimersByTime(FIRST_TURN_WATCH_MS);
		expect(asked).toEqual([]);
		expect(said).toEqual([]);
	});
});
