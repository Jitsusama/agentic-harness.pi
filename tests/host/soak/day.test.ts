/**
 * A day's run is read from what the soak printed: its report cut into
 * the files a reader checks the figures by, and the day's figures,
 * bursts and the opening's loop beside the bar.
 */
import { describe, expect, it } from "vitest";
import { figuresOf, filesOf, reportIn } from "./day.ts";

/** A soak's report, cut down to what a day reads. */
const report = {
	conversations: 2,
	turns: 20,
	pace: {},
	coldOpen: { hosted: { ms: 25_300, loopMaxMs: 18_600 }, plainMs: 21_000 },
	opened: { ms: 2900, weight: { loopMaxMs: 1864 } },
	checkpoints: [
		{
			turnsDone: 5,
			atMs: 100,
			awake: { pss: 400_000 },
			windowWakes: [],
			burstWakes: [{ answeredMs: 2000 }, { answeredMs: 3000 }],
			afterBurst: { loopMaxMs: 700 },
		},
		{
			turnsDone: 10,
			atMs: 200,
			awake: { pss: 410_000 },
			burstWakes: [{ answeredMs: 2500 }, { answeredMs: 3500 }],
		},
	],
	restart: {
		toSocketMs: 1400,
		parkedAtStart: 2,
		wakes: [{ answeredMs: 4000 }, { answeredMs: 4400 }],
		allAnsweredMs: 6000,
		after: { loopMaxMs: 1700 },
	},
	restartMid: { cut: ["c1-t5"] },
	heap: { parked: { verdict: "settles" } },
	latency: {
		hosted: { count: 18, p50: 100, p99: 600 },
		plain: { count: 18, p50: 10, p99: 100 },
		paired: { count: 18, p50: 90, p99: 500, unpaired: 0 },
		bar: { rounds: true, tools: false },
		screen: { burst: { keyToAccepted: { count: 4, p50: 60, p99: 750 } } },
	},
	turnsTimed: [{ tag: "c0-t0" }],
	parity: [{ unexpected: 1 }, { unexpected: 2 }],
	faults: ["one"],
	hostErrors: [],
	plainErrors: ["two"],
};

describe("a day's run", () => {
	it("is read from the last report the soak printed", () => {
		const said = `soak x checkpoint 1\nsoak report: {"turns":1}\nsoak report: ${JSON.stringify(report)}\nexit 0\n`;
		expect(reportIn(said), "the last report").toEqual(report);
		expect(reportIn("soak x lost\n"), "a run lost before its end").toBe(
			undefined,
		);
	});

	it("is cut into the whole report, each turn, and each wake", () => {
		const files = filesOf(report);
		expect(files["report.json"], "the whole report").toBe(report);
		expect(files["turns.json"], "each turn").toEqual([{ tag: "c0-t0" }]);
		expect(files["wakes.json"], "each wake, by checkpoint").toMatchObject({
			coldOpen: report.coldOpen,
			opened: report.opened,
			checkpoints: [
				{ checkpoint: 1, turnsDone: 5, burstWakes: [{}, {}] },
				{ checkpoint: 2, turnsDone: 10 },
			],
			restart: { toSocketMs: 1400 },
			restartMid: { cut: ["c1-t5"] },
		});
	});

	it("says its figures, the bursts and the opening's loop beside the bar", () => {
		expect(figuresOf(report), "the day's figures").toMatchObject({
			turns: 20,
			faults: 1,
			errors: 1,
			parityUnexpected: 3,
			bar: { rounds: true, tools: false },
			burst: {
				keys: { p99: 750 },
				wakes: { count: 4, p50: 2500, p99: 3500 },
				slowestByCheckpoint: [3000, 3500],
			},
			coldOpen: { hosted: { ms: 25_300, loopMaxMs: 18_600 }, plainMs: 21_000 },
			openingLoopMaxMs: 1864,
			openedMs: 2900,
			awakePssKb: [400_000, 410_000],
			restart: {
				toSocketMs: 1400,
				wakes: { count: 2, p99: 4400 },
				loopMaxMs: 1700,
			},
			restartMid: { cut: ["c1-t5"] },
		});
		expect(figuresOf(report).real, "no real model's figures without one").toBe(
			undefined,
		);
	});

	it("says a real-model slice's refusals and tokens", () => {
		const usage = { hosted: { input: 30 }, plain: { input: 31 } };
		const refusal = { tag: "c0-t1", status: 400, said: "no" };
		const real = { model: "claude-haiku-5-5", refusals: [refusal], usage };
		expect(figuresOf({ ...report, real }).real).toEqual({
			model: "claude-haiku-5-5",
			refusals: 1,
			usage,
		});
	});
});
