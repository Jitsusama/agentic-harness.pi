/**
 * A running review round, in real pi: a board docked above an editor that
 * stays live.
 *
 * The complaint this answers is the fleet's, a quarter of an hour at a
 * time: while a council ran, its panel replaced the editor and a listener
 * swallowed Escape wherever focus was, so nothing could be typed until
 * every reviewer had answered. The board now docks above the editor, the
 * hop chord reaches its keys, and it leaves in the frame the answer's card
 * arrives, with a card at least as tall.
 *
 * The fixture tool goes through `answerWatching` and `renderAnswer`, the
 * same composition `review_ask` does, with the reviewers replaced by
 * promises the test settles. Driving `review_ask` itself would need a
 * roster, a change and a subagent runner, none of which the board is
 * about.
 */

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { AskRound } from "@jitsusama/agentic-harness.core/review";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import panelLifecycle from "../../extensions/panel-lifecycle-workflow/index.ts";
import {
	answerWatching,
	type RoundWatch,
} from "../../extensions/review-integration/progress.ts";
import {
	type Answer,
	renderAnswer,
	say,
} from "../../extensions/review-integration/tools/shared.ts";
import { bootPi, type PiSession, sleep, strip, waitFor } from "./pi-session.ts";

/** The model every reviewer here shares, so it is named once in the title. */
const MODEL = "anthropic/claude-opus-5";

/**
 * How long the call goes on after its rounds have finished.
 *
 * A real one files findings and writes a run record there. Held longer
 * than a frame so pi draws in the gap, which is the gap a board that left
 * as its round finished would leave blank.
 */
const SETTLE_MS = 80;

/** A reviewer the test is holding, and how to let it answer. */
interface Held {
	readonly signal: AbortSignal;
	answer(findings?: number): void;
}

let held: Map<string, Held>;
let pi: PiSession | undefined;

/** Hold one reviewer until the test answers for it or it is stopped. */
function reviewer(watch: RoundWatch, id: string): Promise<void> {
	return new Promise((resolve) => {
		const signal = watch.signalFor(id);
		watch.progress.started(id);
		watch.progress.activity(id, `reading MARK-activity-${id}`);
		held.set(id, {
			signal,
			answer: (findings = 2) => {
				watch.progress.answered(id);
				watch.progress.recorded(id, findings);
				resolve();
			},
		});
		signal.addEventListener(
			"abort",
			() => {
				watch.progress.cancelled(id);
				resolve();
			},
			{ once: true },
		);
	});
}

/** A tool that runs the rounds it is given, each with its reviewers. */
function roundsFixture(rounds: ReadonlyArray<[AskRound, string[]]>) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "fixture_round",
			label: "Round",
			description: "Runs review rounds until the test settles them.",
			parameters: Type.Object({}),
			execute: (
				_id: string,
				_params: unknown,
				signal: AbortSignal | undefined,
				_update: unknown,
				ctx: ExtensionContext,
			): Promise<Answer> =>
				answerWatching(ctx, signal, async (watch) => {
					const running = rounds.map(([round, ids]) => {
						const made = watch(round);
						made.progress.start(ids.map((id) => ({ id, model: MODEL })));
						return Promise.all(ids.map((id) => reviewer(made, id))).then(() =>
							made.progress.finish(),
						);
					});
					await Promise.all(running);
					await sleep(SETTLE_MS);
					return say("MARK-digest of the round\nsecond line of it");
				}),
			renderResult: (
				result: Answer,
				options: { expanded?: boolean },
				theme: Theme,
				context?: { lastComponent?: unknown },
			) => renderAnswer(result, theme, options, context?.lastComponent),
		});
	};
}

beforeEach(() => {
	held = new Map();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	for (const one of held.values()) one.answer();
	await pi?.stop();
	pi = undefined;
	vi.restoreAllMocks();
});

/** Boots pi with the fixture and the hop, and starts its rounds. */
async function startRounds(
	rounds: ReadonlyArray<[AskRound, string[]]>,
	options: { rows?: number; history?: number } = {},
): Promise<PiSession> {
	const session = await bootPi({
		cols: 100,
		rows: options.rows ?? 30,
		extensions: [roundsFixture(rounds), panelLifecycle],
	});
	pi = session;
	for (let turn = 0; turn < (options.history ?? 0); turn++) {
		session.answer(`MARK-history-${turn} ${"lorem ipsum ".repeat(12)}`);
		await session.prompt(`question ${turn}`);
		await waitFor(
			() => !session.runtime.session.isStreaming,
			`history turn ${turn}`,
		);
	}
	session.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture_round", {})),
		fauxAssistantMessage("MARK-after-the-round"),
	]);
	session.mark("round");
	await session.prompt("run the round");
	const ids = rounds.flatMap(([, one]) => one);
	await waitFor(() => held.size === ids.length, "every reviewer to start");
	// The last board opened, so a first board that was replaced by it is a
	// failure the tests below name rather than a wait that times out.
	await waitFor(
		async () => (await session.inBuffer(ids.at(-1) ?? "")) > 0,
		"the boards",
	);
	return session;
}

const COUNCIL: ReadonlyArray<[AskRound, string[]]> = [
	["council", ["alpha", "beta"]],
];

describe("a running round", () => {
	it("leaves the editor focused and typable", async () => {
		const session = await startRounds(COUNCIL);

		await session.type("a steer");

		expect(session.editorText()).toBe("a steer");
		expect(await session.onScreen("MARK-activity-alpha")).toBe(true);
		expect(await session.onScreen("MARK-activity-beta")).toBe(true);
	});

	it("says how to reach its keys, and not the keys it cannot yet take", async () => {
		const session = await startRounds(COUNCIL);

		expect(await session.onScreen("Ctrl+Alt+N to manage")).toBe(true);
		expect(await session.onScreen("r cancel selected")).toBe(false);
	});

	it("leaves Escape to pi, which stops the turn and so the round", async () => {
		const session = await startRounds(COUNCIL);

		await session.key("escape");

		await waitFor(
			() => held.get("alpha")?.signal.aborted === true,
			"the reviewer to be stopped",
		);
		await waitFor(
			() => !session.runtime.session.isStreaming,
			"the turn to stop",
		);
		expect(await session.onScreen("MARK-after-the-round")).toBe(false);
	});
});

describe("the board, once the hop chord reaches it", () => {
	it("says its keys", async () => {
		const session = await startRounds(COUNCIL);

		await session.key("ctrl+alt+n");

		await waitFor(
			() => session.onScreen("r cancel selected"),
			"the keys to be said",
		);
	});

	it("cancels the selected reviewer alone with r", async () => {
		const session = await startRounds(COUNCIL);

		await session.key("ctrl+alt+n");
		await session.key("down");
		await session.key("r");

		await waitFor(
			() => held.get("beta")?.signal.aborted === true,
			"beta to be stopped",
		);
		expect(held.get("alpha")?.signal.aborted).toBe(false);
		expect(session.runtime.session.isStreaming).toBe(true);
		await waitFor(
			() => session.onScreen("cancelled beta"),
			"the board to say so",
		);
	});

	it("cancels the round with Escape and hands the editor back, the turn going on", async () => {
		const session = await startRounds(COUNCIL);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("escape");

		await waitFor(
			() => held.get("alpha")?.signal.aborted === true,
			"alpha to be stopped",
		);
		expect(held.get("beta")?.signal.aborted).toBe(true);
		expect(session.editorFocused()).toBe(true);
		await waitFor(
			() => session.onScreen("MARK-after-the-round"),
			"the turn to carry on past the round",
		);
	});

	it("gives the editor back on the same chord, cancelling nothing", async () => {
		const session = await startRounds(COUNCIL);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("ctrl+alt+n");

		expect(session.editorFocused()).toBe(true);
		await session.type("x");
		expect(session.editorText()).toBe("x");
		expect(held.get("alpha")?.signal.aborted).toBe(false);
	});
});

describe("when the round's call returns", () => {
	it("leaves in the frame its card arrives, with no blank rows behind", async () => {
		// A council the size of a real one. With two reviewers the digest
		// alone is as tall as the board, so a card that dropped the board's
		// rows would pass; with seven it leaves them blank.
		const seven = ["a", "b", "c", "d", "e", "f", "g"].map(
			(one) => `rev-${one}`,
		);
		const session = await startRounds([["council", seven]], { history: 4 });

		session.mark("finish");
		for (const one of held.values()) one.answer();
		await waitFor(
			() => session.onScreen("MARK-after-the-round"),
			"the turn to finish",
		);
		await sleep(50);

		const verdict = await session.verdict();
		expect(verdict.desync).toEqual([]);
		expect(verdict.hygiene).toEqual([]);
		expect(verdict.blankMax).toBe(0);
		expect(await session.onScreen("Ctrl+Alt+N")).toBe(false);
		expect(await session.onScreen("MARK-digest")).toBe(true);
		expect(session.editorFocused()).toBe(true);
	});

	it("keeps the rows on its card, answered, after the board has gone", async () => {
		const session = await startRounds(COUNCIL);

		for (const one of held.values()) one.answer(3);
		await waitFor(
			() => session.onScreen("MARK-after-the-round"),
			"the turn to finish",
		);

		const screen = (await session.viewport()).map(strip).join("\n");
		expect(screen).toMatch(/alpha .*3 findings/);
		expect(screen).toMatch(/beta .*3 findings/);
		expect(screen).toContain("2/2 answered");
	});
});

describe("a board whose clock ticks", () => {
	it("redraws in place, never forcing pi to redraw the transcript", async () => {
		const session = await startRounds(COUNCIL, { rows: 20, history: 3 });

		session.mark("ticking");
		// Long enough for two ticks of the elapsed clock.
		await sleep(2_300);

		const verdict = await session.verdict();
		expect(verdict.redrawsAt.filter((at) => at.startsWith("ticking"))).toEqual(
			[],
		);
		expect(verdict.desync).toEqual([]);
	});
});

describe("two rounds in one call", () => {
	const TWO: ReadonlyArray<[AskRound, string[]]> = [
		["council", ["alpha", "beta"]],
		["judge", ["gamma"]],
	];

	it("draws a board for each", async () => {
		const session = await startRounds(TWO);

		expect(await session.onScreen("MARK-activity-alpha")).toBe(true);
		expect(await session.onScreen("MARK-activity-gamma")).toBe(true);
	});

	it("hops into the first, whose Escape stops that round alone", async () => {
		const session = await startRounds(TWO);

		await session.key("ctrl+alt+n");
		expect(session.editorFocused()).toBe(false);
		await session.key("escape");

		// Escape on a board hands the editor back as it cancels, so this is
		// the moment the cancelling has been done.
		await waitFor(() => session.editorFocused(), "the editor to come back");
		expect(held.get("alpha")?.signal.aborted).toBe(true);
		expect(held.get("gamma")?.signal.aborted).toBe(false);
		expect(session.runtime.session.isStreaming).toBe(true);
	});
});
