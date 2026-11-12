/**
 * What the soak reports: each turn's latency from its prompt's entry to
 * its final answer's, the 50th and 99th percentiles, a series of
 * weighings judged settled or growing, and the differences between a
 * hosted log and plain pi's once each side's folder is a label. And what
 * its provider answers each request with.
 */
import { describe, expect, it } from "vitest";
import {
	entriesOf,
	growthOf,
	latencies,
	parityOf,
	spreadOf,
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
