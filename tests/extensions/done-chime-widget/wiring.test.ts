/**
 * The widget driven through the events pi emits, with the ring itself
 * stood in for, so nothing plays.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import doneChimeWidget from "../../../extensions/done-chime-widget/index.ts";
import { LOOKED_AWAY_MS } from "../../../extensions/done-chime-widget/when.ts";
import { goAway, resetAway } from "../../../lib/internal/away/state.ts";

/** What would have been said out loud. */
const rung = vi.hoisted(() => [] as string[]);
vi.mock("../../../extensions/done-chime-widget/ring.ts", async (original) => ({
	...(await original<object>()),
	ring: async (line: string) => {
		rung.push(line);
		return true;
	},
}));

/** What went to the system's log. */
const logged = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/internal/session/journal.ts", async (original) => ({
	...(await original<object>()),
	sayInJournal: (text: string) => logged.push(text),
}));

/** Let the ring's promise settle, as the widget doesn't wait on it. */
async function rungOut(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function loaded({ hasUI = true, name = "Done chime" } = {}) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getSessionName: () => name,
	};
	doneChimeWidget(pi as unknown as ExtensionAPI);
	const ctx = {
		hasUI,
		cwd: "/work/tree",
		sessionManager: { getSessionId: () => "S1" },
	};
	const fire = (event: string, payload: object = {}) =>
		handlers.get(event)?.({ type: event, ...payload }, ctx);
	return {
		typed: (text = "make it ring") =>
			fire("input", { text, source: "interactive" }),
		woken: () => fire("before_agent_start", { messageType: "custom" }),
		settled: (aborted = false) => fire("agent_settled", { aborted }),
	};
}

/** Time passing while the run works. */
const passes = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
	vi.useFakeTimers();
	rung.length = 0;
	logged.length = 0;
});

afterEach(() => {
	vi.useRealTimers();
	resetAway();
});

describe("the done chime", () => {
	it("rings once, naming the session, when a run the person typed ends late", async () => {
		const session = loaded();

		await session.typed();
		passes(LOOKED_AWAY_MS);
		await session.settled();
		await session.settled();

		expect(rung).toEqual(["Done chime is ready."]);
	});

	// 2RCBOJ, 12 November: 86 dings in a day, counted only from session
	// logs, since a ding left no line of its own.
	it("says in the system's log each time it rings, and nothing when it doesn't", async () => {
		const session = loaded();
		await session.typed();
		passes(LOOKED_AWAY_MS - 1);
		await session.settled();
		await rungOut();
		expect(logged, "a run he still watched").toEqual([]);

		await session.typed();
		passes(LOOKED_AWAY_MS);
		await session.settled();
		await rungOut();

		expect(logged).toEqual([
			`pi: done ding, session S1, ${LOOKED_AWAY_MS / 1000} s after the person typed`,
		]);
	});

	it("stays quiet for a run that ends while the person still watches", async () => {
		const session = loaded();
		await session.typed();
		passes(LOOKED_AWAY_MS - 1);
		await session.settled();
		expect(rung).toEqual([]);
	});

	it("stays quiet for a run a message woke, after the person's typing went nowhere", async () => {
		const session = loaded();
		await session.typed("/a command another extension handled");
		await session.woken();
		passes(LOOKED_AWAY_MS);
		await session.settled();
		expect(rung).toEqual([]);
	});

	it("stays quiet where nobody can be at the session", async () => {
		const session = loaded({ hasUI: false });
		await session.typed();
		passes(LOOKED_AWAY_MS);
		await session.settled();
		expect(rung).toEqual([]);
	});

	it("stays quiet for a run the person stopped", async () => {
		const session = loaded();
		await session.typed();
		passes(LOOKED_AWAY_MS);
		await session.settled(true);
		expect(rung).toEqual([]);
	});

	it("stays quiet while the person is away from the machine", async () => {
		const session = loaded();
		await session.typed("I'm off to bed, keep going");
		goAway("keep going");
		passes(LOOKED_AWAY_MS);
		await session.settled();
		expect(rung).toEqual([]);
	});
});
