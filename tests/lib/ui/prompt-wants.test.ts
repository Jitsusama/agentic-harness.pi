/**
 * A prompt left unanswered says its session wants its person, as an
 * approval by its title unless it says otherwise, and a question that
 * says its choices takes an answer given from away. The panel itself is
 * stood in for: what is checked is what the prompt says while it waits.
 */

import {
	createEventBus,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	answerWant,
	forgetWants,
	onWants,
	sessionWants,
	WANT_AFTER_MS,
	type WantEvent,
	wantId,
} from "../../../lib/internal/session/wants.ts";
import { promptSingle, promptTabbed } from "../../../lib/ui/panel.ts";
import type { AnsweredElsewhere } from "../../../lib/ui/prompt-single.ts";

const { answers, shown } = vi.hoisted(() => {
	const answers = {
		resolve: (_: unknown) => {},
		verdict: (): string | undefined => undefined,
	};
	// Comes down as the real panel does once answered from elsewhere.
	const shown = (_ctx: unknown, _config: unknown, away?: AnsweredElsewhere) =>
		new Promise((resolve) => {
			answers.resolve = resolve;
			answers.verdict = () => away?.verdict();
			away?.signal.addEventListener("abort", () => resolve(null));
		});
	return { answers, shown };
});
vi.mock("../../../lib/ui/prompt-single.ts", () => ({
	showSinglePrompt: shown,
	elsewhereVerdict: () => "Picked, from outside this window",
}));
vi.mock("../../../lib/ui/prompt-tabbed.ts", () => ({
	showTabbedPrompt: shown,
}));

const ctx = { hasUI: true } as unknown as ExtensionContext;
const CHOICES = [
	{ label: "Keep it", value: "keep" },
	{ label: "Roll it back", value: "back" },
	{ label: "Type something...", value: "__other__", opensEditor: true },
];
const ASK = {
	choices: [
		{ value: "keep", label: "Keep it" },
		{ value: "back", label: "Roll it back" },
	],
	allowOther: true,
};
const content = () => [];
let heard: WantEvent[] = [];

/** The id of the first want said, as the launcher would name it. */
function firstWant(): string {
	const first = heard[0];
	return first && "since" in first ? wantId(first.kind, first.since) : "";
}

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

	it("takes a choice given from away as picked, and says so in its record", async () => {
		const answer = promptSingle(ctx, {
			content,
			options: CHOICES,
			want: { kind: "question", said: "Keep the bar?", ask: ASK },
		});
		vi.advanceTimersByTime(WANT_AFTER_MS);
		const id = firstWant();

		expect(heard[0], "the want says its choices").toMatchObject({ ask: ASK });
		expect(answers.verdict(), "no record before an answer").toBeUndefined();
		expect(answerWant(id, { value: "back" }), "the panel takes it").toBe(true);
		await expect(answer, "answered as if picked").resolves.toEqual({
			type: "option",
			value: "back",
		});
		expect(answers.verdict(), "its record says where").toBe(
			"Picked, from outside this window",
		);
		expect(heard.at(-1), "the want ends").toEqual({
			kind: "question",
			said: null,
		});
		expect(answerWant(id, { value: "keep" }), "answered once").toBe(false);
	});

	it("takes words given from away as typed into the option that opens an editor", async () => {
		const answer = promptSingle(ctx, {
			content,
			options: CHOICES,
			want: { kind: "question", said: "Keep the bar?", ask: ASK },
		});
		vi.advanceTimersByTime(WANT_AFTER_MS);
		const id = firstWant();

		expect(answerWant(id, { other: "Shorter" }), "the panel takes it").toBe(
			true,
		);
		await expect(answer, "answered as if typed").resolves.toEqual({
			type: "option",
			value: "__other__",
			editorText: "Shorter",
		});
	});

	it("takes nothing from away when it says no choices", async () => {
		const answer = promptSingle(ctx, {
			content,
			options: CHOICES,
			want: { kind: "question", said: "Keep the bar?" },
		});
		vi.advanceTimersByTime(WANT_AFTER_MS);
		const id = firstWant();

		expect(heard[0], "the want says no choices").not.toHaveProperty("ask");
		expect(answerWant(id, { value: "back" }), "nothing takes it").toBe(false);
		answers.resolve(null);
		await answer;
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
