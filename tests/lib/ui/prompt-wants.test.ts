/**
 * A prompt left unanswered says its session wants its person, as an
 * approval by its title unless it says otherwise. The panel itself is
 * stood in for: what is checked is what the prompt says while it waits.
 */

import {
	createEventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgetWants,
	onWants,
	sessionWants,
	WANT_AFTER_MS,
	type WantEvent,
} from "../../../lib/internal/session/wants.ts";
import { promptSingle, promptTabbed } from "../../../lib/ui/panel.ts";

const { answers, shown } = vi.hoisted(() => {
	const answers = { resolve: (_: unknown) => {} };
	const shown = () =>
		new Promise((resolve) => {
			answers.resolve = resolve;
		});
	return { answers, shown };
});
vi.mock("../../../lib/ui/prompt-single.ts", () => ({
	showSinglePrompt: shown,
}));
vi.mock("../../../lib/ui/prompt-tabbed.ts", () => ({
	showTabbedPrompt: shown,
}));

const ctx = { hasUI: true } as unknown as ExtensionContext;
const content = () => [];
let heard: WantEvent[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	forgetWants();
	const bus = createEventBus();
	heard = [];
	onWants(bus, (want) => heard.push(want));
	sessionWants().bind(bus);
});

afterEach(() => {
	vi.useRealTimers();
	forgetWants();
});

describe("a prompt waited on", () => {
	it("wants an approval by its title until answered", async () => {
		const answer = promptSingle(ctx, {
			title: "Open PR #1",
			content,
			actions: [],
		});
		vi.advanceTimersByTime(WANT_AFTER_MS);
		answers.resolve(null);
		await answer;

		expect(heard.map((w) => [w.kind, w.said])).toEqual([
			["approval", "Open PR #1"],
			["approval", null],
		]);
	});

	it("wants what it says it waits for, a question asked through tabs too", async () => {
		const answer = promptTabbed(ctx, {
			items: [],
			want: { kind: "question", said: "2 questions: Which?" },
		});
		vi.advanceTimersByTime(WANT_AFTER_MS);
		answers.resolve(null);
		await answer;

		expect(heard.map((w) => [w.kind, w.said])).toEqual([
			["question", "2 questions: Which?"],
			["question", null],
		]);
	});

	it("wants nothing when answered before the wait counts", async () => {
		const answer = promptSingle(ctx, { content, actions: [] });
		vi.advanceTimersByTime(WANT_AFTER_MS - 1);
		answers.resolve(null);
		await answer;
		vi.advanceTimersByTime(WANT_AFTER_MS);

		expect(heard).toEqual([]);
	});
});
