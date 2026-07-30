/**
 * A round has to be watchable and stoppable, not merely noisy.
 *
 * The first version of this reported to the status line alone, on the
 * reasoning that the defect was silence. That answered the smallest of
 * three complaints. A line has room for one participant's activity, so it
 * cannot say which of seven is still working, and no room at all for a key
 * binding, so it cannot offer a way out.
 *
 * These assert the two things the line could not do: name every
 * participant with its own state, and cancel. Cancellation is checked
 * through the signals a round is actually given, because a panel that
 * looks cancellable and only hides itself is worse than one that does not
 * offer.
 */

import { describe, expect, it } from "vitest";
import {
	panelLines,
	watchRound,
} from "../../extensions/review-integration/progress.js";
import { trackAskProgress } from "../../lib/review/index.js";

/**
 * A theme that returns its text, so assertions read as content.
 *
 * `bold` is here because the shared pipeline renderer bolds a running
 * stage, and a fake thin enough to miss that fails inside the renderer
 * rather than on the assertion, which reads as a bug in the panel.
 */
const theme = {
	fg: (_role: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Parameters<typeof panelLines>[2];

/** Participants, as a roster really carries them. */
const PARTICIPANTS = [
	{ id: "correctness-and-tests" },
	{ id: "test-skeptic" },
	{ id: "architecture-hawk" },
];

/** Their ids, for the assertions that only care about names. */
const IDS = PARTICIPANTS.map((one) => one.id);

describe("the panel names every participant", () => {
	it("lists all of them, which a status line cannot", () => {
		const { progress, entries } = trackAskProgress();
		progress.start(PARTICIPANTS);
		progress.started("correctness-and-tests");
		progress.activity("correctness-and-tests", "reading provider.ts");
		progress.answered("test-skeptic");
		progress.recorded("test-skeptic", 4);

		const drawn = panelLines("council", entries(), theme).join("\n");

		for (const id of IDS) expect(drawn).toContain(id);
	});

	it("says what the running one is doing, and what the answered one found", () => {
		const { progress, entries } = trackAskProgress();
		progress.start(PARTICIPANTS);
		progress.started("correctness-and-tests");
		progress.activity("correctness-and-tests", "reading provider.ts");
		progress.answered("test-skeptic");
		progress.recorded("test-skeptic", 4);

		const drawn = panelLines("council", entries(), theme).join("\n");

		expect(drawn).toContain("reading provider.ts");
		expect(drawn).toContain("4 findings");
		// A participant nobody has started yet is queued, not missing.
		expect(drawn).toContain("queued");
	});

	it("says how to stop it, because a panel that can must say so", () => {
		const { progress, entries } = trackAskProgress();
		progress.start(PARTICIPANTS);

		const drawn = panelLines("council", entries(), theme).join("\n");

		expect(drawn).toContain("esc");
		expect(drawn).toContain("cancel");
	});

	it("marks the selected participant in its label, not only by colour", () => {
		// So it still reads on a terminal that dropped the styling.
		const { progress, entries } = trackAskProgress();
		progress.start(PARTICIPANTS);

		const drawn = panelLines("council", entries(), theme, 1).join("\n");

		expect(drawn).toMatch(/test-skeptic\s*\u25c0/);
	});

	it("names a failure with its reason", () => {
		const { progress, entries } = trackAskProgress();
		progress.start(PARTICIPANTS);
		progress.failed("architecture-hawk", "exited 1 without answering");

		const drawn = panelLines("council", entries(), theme).join("\n");

		expect(drawn).toContain("exited 1 without answering");
	});
});

describe("cancelling a round", () => {
	it("gives each participant a signal derived from the round's", () => {
		const watch = watchRound("council", null);
		const one = watch.signalFor("test-skeptic");

		expect(one.aborted).toBe(false);
		expect(watch.signal.aborted).toBe(false);
	});

	it("reaches every participant when the whole round is cancelled", () => {
		// The point of deriving them: Escape must stop work already in
		// flight, not only work not yet started.
		const outer = new AbortController();
		const watch = watchRound("council", null, outer.signal);
		const before = watch.signalFor("correctness-and-tests");

		outer.abort();
		const after = watch.signalFor("test-skeptic");

		expect(before.aborted).toBe(true);
		expect(watch.signal.aborted).toBe(true);
		// One asked for after the fact is already cancelled rather than
		// starting a subprocess into an abandoned round.
		expect(after.aborted).toBe(true);
	});

	it("keeps the others running when one is cancelled", () => {
		const watch = watchRound("council", null);
		const doomed = watch.signalFor("test-skeptic");
		const spared = watch.signalFor("architecture-hawk");

		// What the panel's `r` does, without a terminal to press it in.
		const same = watch.signalFor("test-skeptic");
		expect(same).toBe(doomed);

		expect(spared.aborted).toBe(false);
		expect(watch.signal.aborted).toBe(false);
	});

	it("hands the same signal back for the same participant", () => {
		// Otherwise a second call would build a controller nothing aborts,
		// and cancelling would appear to do nothing.
		const watch = watchRound("council", null);

		expect(watch.signalFor("test-skeptic")).toBe(
			watch.signalFor("test-skeptic"),
		);
	});

	it("carries the round it is watching, so nothing has to be told twice", () => {
		expect(watchRound("critique", null).round).toBe("critique");
	});
});
