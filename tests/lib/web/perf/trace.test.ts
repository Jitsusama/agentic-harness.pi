import { describe, expect, it } from "vitest";
import {
	categoriesFor,
	foldTrace,
	type RawTraceEvent,
	renderTrace,
} from "../../../../lib/web/perf/trace.js";

/**
 * Timestamps are microseconds in the protocol, which is what these
 * fixtures use. The shapes come from a real capture: a frame id
 * under args.data.frame, a duration only on complete events, and
 * resource events that carry no frame of their own.
 */
const MINE = "FRAME_MINE";
const THEIRS = "FRAME_THEIRS";
const MY_PID = 100;

/** A complete event, the kind that carries a duration. */
const complete = (
	name: string,
	atUs: number,
	durUs: number,
	frame = MINE,
	pid = MY_PID,
): RawTraceEvent => ({
	name,
	cat: "devtools.timeline",
	ph: "X",
	ts: atUs,
	dur: durUs,
	pid,
	tid: 1,
	args: { data: { frame } },
});

/** An instant event. */
const instant = (
	name: string,
	atUs: number,
	data: Record<string, unknown>,
	pid = MY_PID,
): RawTraceEvent => ({
	name,
	cat: "devtools.timeline",
	ph: "I",
	ts: atUs,
	pid,
	tid: 1,
	args: { data },
});

/** A timer firing, which names the timer it belongs to. */
const timerFire = (
	atUs: number,
	durUs: number,
	timerId: number,
	frame = MINE,
): RawTraceEvent => ({
	name: "TimerFire",
	cat: "devtools.timeline",
	ph: "X",
	ts: atUs,
	dur: durUs,
	pid: MY_PID,
	tid: 1,
	args: { data: { frame, timerId } },
});

const fold = (events: readonly RawTraceEvent[]) =>
	foldTrace(events, { frames: new Set([MINE]), profiles: ["async"] });

describe("categoriesFor", () => {
	it("never asks for the default category set", () => {
		// Measured: naming no categories costs about 5 MB a second
		// and is almost entirely Chrome's own scheduler and IPC.
		expect(categoriesFor(["async"]).length).toBeGreaterThan(0);
	});

	it("unions the profiles without repeating a category", () => {
		const both = categoriesFor(["async", "frames"]);

		expect(both).toContain("devtools.timeline");
		expect(both).toContain("disabled-by-default-devtools.timeline.frame");
		expect(both.length).toBe(new Set(both).size);
	});
});

describe("foldTrace timers", () => {
	it("pairs an install with the fire that followed it", () => {
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 7,
				timeout: 50,
				singleShot: true,
			}),
			timerFire(1_080_000, 4_000, 7),
		]);

		expect(capture.timers).toHaveLength(1);
		const [timer] = capture.timers;
		expect(timer.timerId).toBe(7);
		expect(timer.timeoutMs).toBe(50);
		expect(timer.installedAtMs).toBe(0);
		// Asked for 50ms, fired at 80ms, so it was 30ms late.
		expect(timer.firedAtMs).toBe(80);
		expect(timer.lateByMs).toBe(30);
		expect(timer.ranForMs).toBe(4);
	});

	it("does not pair a fire with an install that was already removed", () => {
		// Chrome recycles timer ids within a frame, so an id alone
		// is not an identity. Keyed naively, this fire would be
		// blamed on the first install and report a wild lateness.
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 3,
				timeout: 10,
				singleShot: true,
			}),
			instant("TimerRemove", 1_005_000, { frame: MINE, timerId: 3 }),
			instant("TimerInstall", 1_500_000, {
				frame: MINE,
				timerId: 3,
				timeout: 20,
				singleShot: true,
			}),
			timerFire(1_520_000, 1_000, 3),
		]);

		const fired = capture.timers.filter((t) => t.firedAtMs !== undefined);
		expect(fired).toHaveLength(1);
		expect(fired[0].timeoutMs).toBe(20);
		expect(fired[0].lateByMs).toBe(0);
	});

	it("measures a repeating timer against its previous fire", () => {
		// An interval asked for every 40ms and delivered at 40, 80
		// and 120 is punctual. Measured against the install instead,
		// the third fire looks 80ms late and the page gets blamed
		// for a delay that never happened.
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 4,
				timeout: 40,
				singleShot: false,
			}),
			timerFire(1_040_000, 1_000, 4),
			timerFire(1_080_000, 1_000, 4),
			timerFire(1_120_000, 1_000, 4),
		]);

		expect(capture.timers).toHaveLength(1);
		expect(capture.timers[0].firedCount).toBe(3);
		expect(capture.timers[0].lateByMs).toBe(0);
	});

	it("reports the worst lateness a repeating timer suffered", () => {
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 5,
				timeout: 40,
				singleShot: false,
			}),
			timerFire(1_040_000, 1_000, 5),
			// Blocked: this one arrives 60ms after the last, not 40.
			timerFire(1_140_000, 1_000, 5),
			timerFire(1_180_000, 1_000, 5),
		]);

		expect(capture.timers[0].firedCount).toBe(3);
		expect(capture.timers[0].lateByMs).toBe(60);
	});

	it("counts a single shot as having fired once", () => {
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 6,
				timeout: 10,
				singleShot: true,
			}),
			timerFire(1_010_000, 1_000, 6),
		]);

		expect(capture.timers[0].firedCount).toBe(1);
	});

	it("keeps an installed timer that never fired", () => {
		const capture = fold([
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 1,
				timeout: 5_000,
				singleShot: true,
			}),
		]);

		expect(capture.timers).toHaveLength(1);
		expect(capture.timers[0].firedAtMs).toBeUndefined();
		expect(capture.timers[0].firedCount).toBe(0);
	});
});

describe("foldTrace requests", () => {
	const send = (id: string, atUs: number, url: string, frame = MINE) =>
		instant("ResourceSendRequest", atUs, {
			requestId: id,
			url,
			requestMethod: "GET",
			resourceType: "Fetch",
			frame,
		});

	it("joins a send to its response and finish by request id", () => {
		const capture = fold([
			send("R1", 1_000_000, "https://example.test/a"),
			instant("ResourceReceiveResponse", 1_200_000, {
				requestId: "R1",
				statusCode: 200,
				frame: MINE,
			}),
			instant("ResourceFinish", 1_300_000, {
				requestId: "R1",
				didFail: false,
			}),
		]);

		expect(capture.requests).toHaveLength(1);
		const [request] = capture.requests;
		expect(request.url).toBe("https://example.test/a");
		expect(request.status).toBe(200);
		expect(request.sentAtMs).toBe(0);
		expect(request.finishedAtMs).toBe(300);
		expect(request.failed).toBe(false);
	});

	it("reports how many were in flight at once", () => {
		// Two overlapping, then a third alone. The answer is two,
		// which is the fact a person asking about waterfalls wants.
		const capture = fold([
			send("R1", 1_000_000, "https://example.test/a"),
			send("R2", 1_100_000, "https://example.test/b"),
			instant("ResourceFinish", 1_400_000, { requestId: "R1" }),
			instant("ResourceFinish", 1_500_000, { requestId: "R2" }),
			send("R3", 2_000_000, "https://example.test/c"),
			instant("ResourceFinish", 2_100_000, { requestId: "R3" }),
		]);

		expect(capture.overlapping).toBe(2);
	});

	it("notices a request that resolved out of the order it was sent", () => {
		const capture = fold([
			send("R1", 1_000_000, "https://example.test/slow"),
			send("R2", 1_050_000, "https://example.test/fast"),
			instant("ResourceFinish", 1_100_000, { requestId: "R2" }),
			instant("ResourceFinish", 1_900_000, { requestId: "R1" }),
		]);

		expect(capture.resolvedOutOfOrder).toBe(true);
	});

	it("drops a request belonging to another session's frame", () => {
		const capture = fold([
			send("R1", 1_000_000, "https://example.test/mine"),
			send("R2", 1_010_000, "https://example.test/theirs", THEIRS),
			instant("ResourceFinish", 1_100_000, { requestId: "R1" }),
			instant("ResourceFinish", 1_200_000, { requestId: "R2" }),
		]);

		expect(capture.requests.map((r) => r.url)).toEqual([
			"https://example.test/mine",
		]);
	});
});

describe("foldTrace attribution", () => {
	it("excludes events belonging to another frame", () => {
		const capture = fold([
			complete("FunctionCall", 1_000_000, 5_000),
			complete("FunctionCall", 1_010_000, 90_000, THEIRS, 200),
		]);

		const calls = capture.tasks.find((t) => t.name === "FunctionCall");
		expect(calls?.count).toBe(1);
		// The foreign 90ms must not be billed to us.
		expect(calls?.totalMs).toBe(5);
	});

	it("claims an event with no frame that came from our own process", () => {
		// Frame-pipeline events carry a layer tree rather than a
		// frame, so the only honest way to place them is the
		// renderer process our own frames were seen in.
		const capture = fold([
			complete("FunctionCall", 1_000_000, 1_000),
			{
				name: "DrawFrame",
				cat: "disabled-by-default-devtools.timeline.frame",
				ph: "I",
				ts: 1_050_000,
				pid: MY_PID,
				tid: 2,
				args: { frameSeqId: 9, layerTreeId: 3 },
			},
		]);

		expect(capture.unattributed).toBe(0);
	});

	it("counts an event it cannot place rather than guessing", () => {
		const capture = fold([
			complete("FunctionCall", 1_000_000, 1_000),
			{
				name: "DrawFrame",
				cat: "disabled-by-default-devtools.timeline.frame",
				ph: "I",
				ts: 1_050_000,
				pid: 999,
				tid: 2,
				args: { frameSeqId: 9 },
			},
		]);

		expect(capture.unattributed).toBe(1);
	});
});

describe("foldTrace tasks", () => {
	it("totals each kind of work and names its longest", () => {
		const capture = fold([
			complete("FunctionCall", 1_000_000, 10_000),
			complete("FunctionCall", 1_020_000, 30_000),
			complete("EventDispatch", 1_060_000, 3_000),
		]);

		const calls = capture.tasks.find((t) => t.name === "FunctionCall");
		expect(calls).toEqual({
			name: "FunctionCall",
			count: 2,
			totalMs: 40,
			longestMs: 30,
		});
		// Ranked by cost, so the expensive kind leads.
		expect(capture.tasks[0].name).toBe("FunctionCall");
	});

	it("measures the span from the first event to the last", () => {
		const capture = fold([
			complete("FunctionCall", 1_000_000, 1_000),
			complete("FunctionCall", 3_000_000, 1_000),
		]);

		expect(capture.spanMs).toBe(2001);
	});
});

describe("foldTrace frames", () => {
	const pipeline = (
		phase: string,
		atUs: number,
		id: string,
	): RawTraceEvent => ({
		name: "PipelineReporter",
		cat: "disabled-by-default-devtools.timeline.frame",
		ph: phase,
		ts: atUs,
		pid: MY_PID,
		tid: 2,
		id2: { local: id },
		args: {},
	});

	it("times each frame from its paired begin and end", () => {
		const capture = foldTrace(
			[
				// A frames recording carries devtools.timeline too, and
				// that is what reveals which renderer we are, since the
				// pipeline events name only a layer tree.
				complete("FunctionCall", 999_000, 500),
				pipeline("b", 1_000_000, "0x1"),
				pipeline("e", 1_008_000, "0x1"),
				pipeline("b", 1_020_000, "0x2"),
				pipeline("e", 1_070_000, "0x2"),
			],
			{ frames: new Set([MINE]), profiles: ["frames"] },
		);

		expect(capture.frames?.counted).toBe(2);
		expect(capture.frames?.longestMs).toBe(50);
		// Sixteen milliseconds is the budget for sixty a second, so
		// the fifty is the one worth showing.
		expect(capture.frames?.slowMs).toEqual([50]);
	});

	it("says nothing about frames when that profile was not asked for", () => {
		const capture = fold([complete("FunctionCall", 1_000_000, 1_000)]);

		expect(capture.frames).toBeUndefined();
	});
});

describe("renderTrace", () => {
	it("reports the span, the costs and what it could not place", () => {
		const capture = fold([
			complete("FunctionCall", 1_000_000, 12_000),
			instant("TimerInstall", 1_000_000, {
				frame: MINE,
				timerId: 1,
				timeout: 50,
				singleShot: true,
			}),
			timerFire(1_090_000, 2_000, 1),
		]);

		const text = renderTrace(capture);

		expect(text).toContain("FunctionCall");
		expect(text).toContain("12");
		expect(text).toMatch(/40ms late|late by 40/i);
	});

	it("says plainly when nothing was recorded", () => {
		const text = renderTrace(fold([]));

		expect(text).toMatch(/nothing/i);
	});

	it("warns that frame figures are not scoped to one session", () => {
		// Frame-pipeline events carry no frame id, so the numbers
		// are the renderer's, and a reader must not take them for
		// this page alone when another page shares the process.
		const capture = foldTrace(
			[
				complete("FunctionCall", 999_000, 500),
				{
					name: "PipelineReporter",
					cat: "disabled-by-default-devtools.timeline.frame",
					ph: "b",
					ts: 1_000_000,
					pid: MY_PID,
					tid: 2,
					id2: { local: "0x1" },
					args: {},
				},
				{
					name: "PipelineReporter",
					cat: "disabled-by-default-devtools.timeline.frame",
					ph: "e",
					ts: 1_005_000,
					pid: MY_PID,
					tid: 2,
					id2: { local: "0x1" },
					args: {},
				},
			],
			{ frames: new Set([MINE]), profiles: ["frames"] },
		);

		expect(renderTrace(capture)).toMatch(/renderer|process|not.*one page/i);
	});
});
