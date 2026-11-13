/**
 * What the soak reports: each turn's latency from its prompt's entry to
 * its final answer's, the 50th and 99th percentiles, a series of
 * weighings judged settled or growing, and the differences between a
 * hosted log and plain pi's once each side's folder is a label. And what
 * its provider answers each request with.
 */
import { describe, expect, it } from "vitest";
import {
	barOf,
	entriesOf,
	growthOf,
	latencies,
	pairedCost,
	parityOf,
	screenSplit,
	slowKeys,
	spreadOf,
	turnRecords,
	turnTimes,
} from "./report.ts";
import { answerTo, JOB } from "./soak-provider.ts";

/** A message entry of a log, at `at` seconds past a fixed minute. */
function entry(
	role: string,
	content: unknown,
	at: number,
): Record<string, unknown> {
	return {
		type: "message",
		id: `e${at}`,
		timestamp: new Date(Date.UTC(2026, 10, 12, 9, 0, at)).toISOString(),
		message: { role, content },
	};
}

describe("a soak's latencies", () => {
	it("run from a prompt's entry to the answer that acknowledges it", () => {
		const log = [
			entry("user", "soak c0-t0 bash, please", 0),
			entry("assistant", [{ type: "toolCall", name: "bash" }], 1),
			entry("toolResult", [{ type: "text", text: "soak bash c0-t0" }], 2),
			entry("assistant", [{ type: "text", text: "done, ack c0-t0." }], 3),
			entry("user", [{ type: "text", text: "soak c0-t1 echo, please" }], 10),
			entry("assistant", [{ type: "text", text: "heard, ack c0-t1." }], 12),
		];
		expect(latencies(log), "two turns, three and two seconds").toEqual([
			{ tag: "c0-t0", ms: 3000 },
			{ tag: "c0-t1", ms: 2000 },
		]);
	});

	it("leave out a turn that was never answered", () => {
		expect(
			latencies([entry("user", "soak c0-t0 echo, please", 0)]),
			"no answer, no latency",
		).toEqual([]);
	});

	it("are read from a log's lines", () => {
		const lines = [entry("user", "hi", 0), entry("assistant", "hello", 1)];
		expect(
			entriesOf(`${lines.map((one) => JSON.stringify(one)).join("\n")}\n`),
			"one entry a line, the blank last line skipped",
		).toEqual(lines);
	});
});

describe("what a screen adds", () => {
	const minute = Date.UTC(2026, 10, 12, 9, 0, 0);
	const log = [
		entry("user", "soak c0-t0 echo, please", 1),
		entry("assistant", [{ type: "text", text: "heard, ack c0-t0." }], 3),
		entry("user", "soak c0-t1 echo, please", 10),
		entry("assistant", [{ type: "text", text: "heard, ack c0-t1." }], 11),
		entry("user", "soak c0-t2 echo, please", 20),
		entry("assistant", [{ type: "text", text: "heard, ack c0-t2." }], 21),
	];

	it("reads each turn's prompt and answer times from the log", () => {
		expect(turnTimes(log)[1], "the second turn's entries").toEqual({
			tag: "c0-t1",
			promptAt: minute + 10_000,
			answerAt: minute + 11_000,
		});
	});

	it("splits keys to the prompt and to its first drawing from the answer's", () => {
		const typed = new Map([
			[
				"c0-t0",
				{ keyAt: minute + 500, shownAt: minute + 600, drawnAt: minute + 3_200 },
			],
			// Drawn as it streamed, before the answer's entry was written.
			[
				"c0-t1",
				{
					keyAt: minute + 9_900,
					shownAt: minute + 10_100,
					drawnAt: minute + 10_900,
				},
			],
			// The first key since its conversation woke, still loading.
			[
				"c0-t2",
				{ keyAt: minute + 19_000, shownAt: minute + 20_100, woke: "mesh" },
			],
		]);
		expect(screenSplit(turnTimes(log), typed), "three turns typed").toEqual({
			keyToAccepted: { count: 2, p50: 100, p99: 500 },
			keyToDrawn: { count: 2, p50: 100, p99: 200 },
			writtenToDrawn: { count: 2, p50: -100, p99: 200 },
			afterWake: {
				keyToAccepted: { count: 1, p50: 1000, p99: 1000 },
				keyToDrawn: { count: 1, p50: 1100, p99: 1100 },
			},
			undrawn: 1,
		});
	});

	it("keeps each turn's times, paired with plain pi's same seeded turn", () => {
		const typed = new Map([
			["c0-t0", { keyAt: minute + 500, shownAt: minute + 600 }],
			["c0-t2", { keyAt: minute + 19_000, woke: "key" }],
		]);
		const plain = [
			{ tag: "c0-t0", ms: 1_500 },
			{ tag: "c0-t1", ms: 1_200 },
		];
		expect(
			turnRecords(turnTimes(log), plain, typed),
			"each hosted turn, with what is known of it",
		).toEqual([
			{
				tag: "c0-t0",
				hostedMs: 2_000,
				plainMs: 1_500,
				keyToAcceptedMs: 500,
				keyToDrawnMs: 100,
			},
			{ tag: "c0-t1", hostedMs: 1_000, plainMs: 1_200 },
			{ tag: "c0-t2", hostedMs: 1_000, keyToAcceptedMs: 1_000, woke: "key" },
		]);
	});

	it("costs each turn as hosted's time less plain pi's for the same one", () => {
		const records = [
			{ tag: "c0-t0", hostedMs: 2_000, plainMs: 1_500 },
			{ tag: "c0-t1", hostedMs: 1_000, plainMs: 1_200 },
			{ tag: "c0-t2", hostedMs: 1_000 },
		];
		expect(
			pairedCost(records),
			"two paired, plain pi's slower one below 0, one plain never answered",
		).toEqual({ count: 2, p50: -200, p99: 500, unpaired: 1 });
	});

	it("names each key slower than the bar, slowest first", () => {
		const typed = new Map([
			["c0-t0", { keyAt: minute + 500 }],
			["c0-t1", { keyAt: minute + 4_000 }],
			["c0-t2", { keyAt: minute + 17_000 }],
		]);
		expect(
			slowKeys(turnTimes(log), typed, 1000, 5),
			"the 6 s and 3 s keys, not the 0.5 s one",
		).toEqual([
			{
				tag: "c0-t1",
				keyAt: minute + 4_000,
				promptAt: minute + 10_000,
				ms: 6_000,
			},
			{
				tag: "c0-t2",
				keyAt: minute + 17_000,
				promptAt: minute + 20_000,
				ms: 3_000,
			},
		]);
		expect(
			slowKeys(turnTimes(log), typed, 1000, 1).map((one) => one.tag),
			"only the slowest, at most one",
		).toEqual(["c0-t1"]);
	});

	it("leaves out a turn no viewer typed", () => {
		expect(
			screenSplit(turnTimes(log), new Map()).keyToAccepted.count,
			"none typed",
		).toBe(0);
	});
});

describe("the bar", () => {
	const within = { count: 5, p50: 20, p99: 150 };
	const screen = {
		keyToAccepted: within,
		keyToDrawn: within,
		writtenToDrawn: within,
		afterWake: { keyToAccepted: within, keyToDrawn: within },
		undrawn: 0,
	};

	it("holds a turn's cost to a second and a key's to 200 ms, at the p99", () => {
		expect(
			barOf({ count: 5, p50: 0, p99: 1_000 }, screen),
			"all three within",
		).toEqual({ paired: true, keyToAccepted: true, keyToDrawn: true });
		expect(
			barOf(
				{ count: 5, p50: 0, p99: 1_001 },
				{ ...screen, keyToDrawn: { count: 5, p50: 20, p99: 201 } },
			),
			"a turn and a drawing each over",
		).toEqual({ paired: false, keyToAccepted: true, keyToDrawn: false });
	});

	it("fails what nothing measured", () => {
		const none = spreadOf([]);
		expect(
			barOf(none, { ...screen, keyToAccepted: none }),
			"no turn paired and no key timed",
		).toEqual({ paired: false, keyToAccepted: false, keyToDrawn: true });
	});
});

describe("a spread", () => {
	it("gives the nearest-rank 50th and 99th percentiles", () => {
		const values = Array.from({ length: 200 }, (_, n) => n + 1);
		expect(spreadOf(values), "of 1 to 200").toEqual({
			count: 200,
			p50: 100,
			p99: 198,
		});
	});
});

describe("a series of weighings", () => {
	it("settles when its later half stops climbing", () => {
		const growth = growthOf([
			90_000, 100_000, 104_000, 105_000, 105_100, 105_050,
		]);
		expect(growth.verdict, JSON.stringify(growth)).toBe("settles");
	});

	it("grows when it keeps climbing past a MB a checkpoint", () => {
		const growth = growthOf([
			90_000, 100_000, 103_000, 106_000, 109_000, 112_000,
		]);
		expect(growth, "three MB a checkpoint to the end").toEqual({
			verdict: "grows",
			grewKb: 12_000,
			lateKbPerCheckpoint: 3000,
		});
	});

	it("settles when it climbs steadily by less than noise", () => {
		const growth = growthOf([90_000, 100_000, 101_100, 102_200, 103_300]);
		expect(growth.verdict, JSON.stringify(growth)).toBe("settles");
	});

	it("can't be judged on fewer than three weighings past its warm-up", () => {
		expect(growthOf([1, 2, 3]).verdict, "too short").toBe("too short");
	});
});

describe("a parity report", () => {
	it("finds no difference between logs that differ only by folder, time and id", () => {
		const hosted = [
			{ ...entry("user", "soak c0-t0 echo, please", 0), cwd: "/h/w1" },
		];
		const plain = [
			{
				...entry("user", "soak c0-t0 echo, please", 7),
				id: "other",
				cwd: "/p/w1",
			},
		];
		expect(
			parityOf(hosted, plain, { hosted: "/h", plain: "/p" }).differences,
			"the same turn",
		).toBe(0);
	});

	it("counts an entry only one side wrote once", () => {
		const turn = entry("user", "soak c0-t0 echo, please", 0);
		const parity = parityOf(
			[{ type: "custom", customType: "host-only" }, turn],
			[turn],
			{ hosted: "/h", plain: "/p" },
		);
		expect(parity.first, "one extra entry, the turn alike").toEqual([
			{ path: "events.actual[0]", kind: "extra-event", actual: "custom" },
		]);
	});

	it("names where the words differ", () => {
		const parity = parityOf(
			[entry("user", "soak c0-t0 echo, please", 0)],
			[entry("user", "soak c0-t0 long, please", 0)],
			{ hosted: "/h", plain: "/p" },
		);
		expect(parity.where, "counted by place").toEqual({
			"events[:message].message.content": 1,
		});
		expect(parity.first, "the one difference").toEqual([
			{
				path: "events[0:message].message.content",
				expected: "soak c0-t0 long, please",
				actual: "soak c0-t0 echo, please",
			},
		]);
	});
});

/** How many differences a parity report names. */
const FIRST_NAMED = 10;

describe("a soak's parity, past what differs on every run", () => {
	it("names a difference of substance before those", () => {
		const sourced = (source: string) =>
			Array.from({ length: 11 }, () => ({
				type: "custom",
				customType: "journal",
				data: { source, journal: { last: { trace_id: source } } },
			}));
		const result = (text: string) =>
			entry("toolResult", [{ type: "text", text }], 2);
		const parity = parityOf(
			[...sourced("hosted"), result("(no output)")],
			[...sourced("plain"), result("soak bash c3-t5")],
			{ hosted: "/h", plain: "/p" },
		);
		expect(
			parity.differences,
			"each side's source and trace, and one",
		).toBeGreaterThan(FIRST_NAMED);
		expect(parity.unexpected, "only the result's words").toBe(1);
		expect(parity.first[0], "named first").toEqual({
			path: "events[11:message].message.content[0].text",
			expected: "soak bash c3-t5",
			actual: "(no output)",
		});
	});
});

describe("a soak's parity, past the provider's numbering", () => {
	it("leaves out the id the provider numbers its answers by", () => {
		const answered = (id: string) => ({
			...entry("assistant", "heard, ack c0-t0.", 1),
			message: { role: "assistant", content: "heard", responseId: id },
		});
		expect(
			parityOf([answered("msg_soak_2")], [answered("msg_soak_76")], {
				hosted: "/h",
				plain: "/p",
			}).differences,
			"the same answer, numbered apart",
		).toBe(0);
	});
});

describe("the soak's provider", () => {
	const user = (text: string) => ({ role: "user", content: text });
	const result = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
	};

	it("echoes an echo turn, acknowledging its tag", () => {
		expect(answerTo([user("soak c0-t1 echo, please")]), "an echo").toEqual({
			type: "text",
			text: "heard, ack c0-t1.",
		});
	});

	it("runs a job turn's bash in the background", () => {
		expect(answerTo([user("soak c0-t7 job, please")]), "a job").toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: JOB, background: true },
		});
	});

	it("acknowledges a tool's result with the turn's tag", () => {
		expect(
			answerTo([
				user("soak c2-t0 read, please"),
				{ role: "assistant" },
				result,
			]),
			"after the read",
		).toEqual({ type: "text", text: "done, ack c2-t0." });
	});

	it("ends a long answer on its acknowledgement", () => {
		const block = answerTo([user("soak c0-t11 long, please")]);
		const text = block.type === "text" ? block.text : "";
		expect(text.split("\n").length, "120 lines").toBe(120);
		expect(text.endsWith("ack c0-t11."), text.slice(-40)).toBe(true);
	});

	it("answers a request with no soak prompt in it all the same", () => {
		expect(answerTo([user("name this session")]), "unscripted").toEqual({
			type: "text",
			text: "soak mock",
		});
	});
});
