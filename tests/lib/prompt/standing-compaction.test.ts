/**
 * A standing context across compactions: said again only when the
 * compaction took away what the model was last told.
 */

import { describe, expect, it } from "vitest";
import {
	newContributions,
	SUMMARY_CONTRIBUTIONS,
} from "../../../lib/compaction/contributions.ts";
import {
	registerStandingContext,
	type StandingContextWording,
} from "../../../lib/prompt/index.ts";

const WORDING: StandingContextWording = {
	customType: "probe-context",
	inPrompt: (text) => `\n\n[Probe] ${text}`,
	changed: (text) => `[Probe] Now: ${text ?? "nothing"}.`,
};

type Entry = {
	id: string;
	type: string;
	customType?: string;
	data?: unknown;
};

/** A pi with one session branch, its handlers and its event bus. */
function harness(state: { current: string | null }) {
	const branch: Entry[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const listeners: ((data: unknown) => void)[] = [];
	let next = 0;
	const add = (entry: Omit<Entry, "id">) => {
		const id = `e${next++}`;
		branch.push({ id, ...entry });
		return id;
	};
	const ctx = {
		sessionManager: { getEntries: () => branch, getBranch: () => branch },
	};
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, fn),
		appendEntry: (customType: string, data: unknown) =>
			add({ type: "custom", customType, data }),
		events: {
			on: (_channel: string, fn: (data: unknown) => void) => listeners.push(fn),
			emit: (_channel: string, data: unknown) => {
				for (const fn of listeners) fn(data);
			},
		},
	};
	registerStandingContext(
		pi as unknown as Parameters<typeof registerStandingContext>[0],
		WORDING,
		() => state.current,
	);
	return {
		start: () => handlers.get("session_start")?.({}, ctx),
		/** Run a prompt, recording any message it sends, as pi would. */
		async prompt(): Promise<string | undefined> {
			const turn = (await handlers.get("before_agent_start")?.(
				{ systemPrompt: "base" },
				ctx,
			)) as { message?: { customType: string; content: string } };
			if (turn.message) {
				add({ type: "custom_message", customType: turn.message.customType });
				return turn.message.content;
			}
			return undefined;
		},
		/** Some conversation, so a compaction has something to cut. */
		talk: () => add({ type: "message" }),
		/** Compact, keeping the tail from `keptFrom`, through the harness or not. */
		async compact(
			keptFrom: string,
			harnessWritesSummary: boolean,
		): Promise<string[]> {
			let details: unknown;
			let appendix: string[] = [];
			if (harnessWritesSummary) {
				const request = newContributions({}, keptFrom);
				pi.events.emit(SUMMARY_CONTRIBUTIONS, request);
				appendix = request.appendix;
				details = { contributions: request.records };
			}
			const compactionEntry = { firstKeptEntryId: keptFrom, details };
			add({ type: "compaction" });
			await handlers.get("session_compact")?.({ compactionEntry }, ctx);
			return appendix;
		},
	};
}

/**
 * A session frozen on A that has since moved to B and said so, with
 * the ids of an entry before the change message and one after it.
 */
async function movedOn() {
	const state = { current: "A" as string | null };
	const h = harness(state);
	await h.start();
	await h.prompt();
	const beforeChange = h.talk();
	state.current = "B";
	expect(await h.prompt()).toBe("[Probe] Now: B.");
	const afterChange = h.talk();
	return { state, h, beforeChange, afterChange };
}

describe("a standing context across a compaction", () => {
	it("stays quiet when the last change survives in the kept tail", async () => {
		const { h, beforeChange } = await movedOn();
		await h.compact(beforeChange, false);
		expect(await h.prompt()).toBeUndefined();
	});

	it("stays quiet when the harness summary carries the change", async () => {
		const { h, afterChange } = await movedOn();
		const appendix = await h.compact(afterChange, true);
		expect(appendix.join("")).toContain("[Probe] Now: B.");
		expect(await h.prompt()).toBeUndefined();
	});

	it("says it again when the change was summarised away by another host", async () => {
		const { h, afterChange } = await movedOn();
		await h.compact(afterChange, false);
		expect(await h.prompt()).toBe("[Probe] Now: B.");
	});

	it("offers the summary nothing while the state is still the frozen one", async () => {
		const state = { current: "A" as string | null };
		const h = harness(state);
		await h.start();
		await h.prompt();
		const kept = h.talk();
		expect(await h.compact(kept, true)).toEqual([]);
		expect(await h.prompt()).toBeUndefined();
	});

	it("stays quiet after a reload that follows a summarised compaction", async () => {
		const { state, h, afterChange } = await movedOn();
		await h.compact(afterChange, true);
		await h.start();
		expect(state.current).toBe("B");
		expect(await h.prompt()).toBeUndefined();
	});
});
