/**
 * The host's collection once it goes quiet: one last-resort collection
 * once no tool call or job runs and no viewer has typed or resized for
 * VIEWER_QUIET_MS, though conversations may be waiting on the model; at
 * most one each SPACING_MS, plus one owed after a park; none until
 * something stirs; one anyway once due CEILING_MS with work running;
 * none, said once, where V8 exposes no gc or its gc throws. Fake timers stand in for the clock; the last cases
 * run V8's own collection and read this process's Pss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CEILING_MS,
	lastResortCollect,
	pssBytes,
	type QuietReading,
	quietCollection,
	runningTools,
	SETTLE_MS,
	SPACING_MS,
	VIEWER_QUIET_MS,
} from "../../../host/engine/quiet-collection.ts";

const MB = 1024 * 1024;

describe("the host's collection once quiet", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function counted(
		reading: () => QuietReading = () => ({ tools: 0, jobs: 0, waiting: 0 }),
	) {
		const collect = vi.fn();
		const said: string[] = [];
		const weighs = [812 * MB, 214 * MB];
		const quiet = quietCollection({
			reading,
			collect,
			weigh: () => weighs.shift(),
			report: (one) => said.push(one),
		});
		return { collect, said, quiet };
	}

	it("collects once a turn has settled, saying the pause and the Pss before and after", () => {
		const { collect, said, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said).toEqual([
			expect.stringMatching(
				/^Collected while quiet in \d+ ms, Pss 812 MB to 214 MB, with 0 conversations waiting on the model$/,
			),
		]);
	});

	it("collects while a conversation only waits on the model, and says how many do", () => {
		const { collect, said, quiet } = counted(() => ({
			tools: 0,
			jobs: 0,
			waiting: 3,
		}));
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said[0]).toMatch(/with 3 conversations waiting on the model$/);
	});

	it("never collects while a tool call or job runs, collecting once none does", () => {
		for (const running of [
			{ tools: 1, jobs: 0 },
			{ tools: 0, jobs: 1 },
		]) {
			let now = running;
			const { collect, quiet } = counted(() => ({ ...now, waiting: 1 }));
			quiet.stirred();
			vi.advanceTimersByTime(SPACING_MS * 2);
			expect(collect).not.toHaveBeenCalled();
			now = { tools: 0, jobs: 0 };
			vi.advanceTimersByTime(SETTLE_MS);
			expect(collect).toHaveBeenCalledTimes(1);
			quiet.stop();
		}
	});

	it("collects anyway once due for an hour with a job running, saying what ran", () => {
		const { collect, said, quiet } = counted(() => ({
			tools: 1,
			jobs: 2,
			waiting: 0,
		}));
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS + CEILING_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said[0]).toMatch(
			/waiting on the model, and 1 tool calls and 2 jobs running, due for 60 minutes$/,
		);
	});

	it("holds even an hour's collection until a viewer has been quiet 30 s", () => {
		const { collect, quiet } = counted(() => ({
			tools: 0,
			jobs: 1,
			waiting: 0,
		}));
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS + CEILING_MS - VIEWER_QUIET_MS / 2);
		quiet.viewed();
		vi.advanceTimersByTime(VIEWER_QUIET_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it("never collects within 30 s of a viewer's key or resize", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		quiet.viewed();
		vi.advanceTimersByTime(VIEWER_QUIET_MS / 2);
		quiet.viewed();
		vi.advanceTimersByTime(VIEWER_QUIET_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it("collects at most once in 10 minutes, however much stirs", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(collect).toHaveBeenCalledTimes(1);
		for (let minute = 0; minute < 9; minute += 1) {
			quiet.stirred();
			vi.advanceTimersByTime(60_000);
		}
		expect(collect).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(SPACING_MS - 9 * 60_000);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it("collects once more after a park inside the 10 minutes, but only once", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		quiet.parked();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(collect).toHaveBeenCalledTimes(2);
		quiet.parked();
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS * 10);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it("holds what a park owes while a viewer types or a tool runs", () => {
		let tools = 1;
		const { collect, quiet } = counted(() => ({ tools, jobs: 0, waiting: 0 }));
		quiet.viewed();
		quiet.parked();
		vi.advanceTimersByTime(VIEWER_QUIET_MS * 2);
		expect(collect).not.toHaveBeenCalled();
		tools = 0;
		vi.advanceTimersByTime(SETTLE_MS);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it("collects no more until something stirs again", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(SPACING_MS * 3);
		expect(collect).toHaveBeenCalledTimes(1);
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it("says a pause over a second as the loop held, as the watchdog says a late beat", () => {
		const said: string[] = [];
		const quiet = quietCollection({
			reading: () => ({ tools: 0, jobs: 0, waiting: 2 }),
			collect: () => {},
			weigh: () => undefined,
			report: (one) => said.push(one),
			clock: (() => {
				const reads = [0, 1240];
				return () => reads.shift() ?? 0;
			})(),
		});
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(said).toEqual([
			"Collected while quiet in 1240 ms, Pss unread, with 2 conversations waiting on the model; the loop held 1.2 s for it",
		]);
	});

	it("starts with collection off, said once, where V8 exposes no gc", () => {
		for (const exposeGc of [
			() => undefined,
			() => {
				throw new Error("no such flag");
			},
		]) {
			const said: string[] = [];
			const quiet = quietCollection({
				reading: () => ({ tools: 0, jobs: 0, waiting: 0 }),
				exposeGc,
				report: (one) => said.push(one),
			});
			quiet.stirred();
			quiet.parked();
			vi.advanceTimersByTime(SPACING_MS);
			expect(said).toEqual([
				"V8 exposed no gc to collect with, so the host won't collect when quiet",
			]);
		}
	});

	it("stops collecting, said once, where V8's gc throws", () => {
		const said: string[] = [];
		const collect = vi.fn(() => {
			throw new Error("unknown flavor");
		});
		const quiet = quietCollection({
			reading: () => ({ tools: 0, jobs: 0, waiting: 0 }),
			collect,
			weigh: () => undefined,
			report: (one) => said.push(one),
		});
		quiet.stirred();
		expect(() => vi.advanceTimersByTime(SETTLE_MS)).not.toThrow();
		quiet.stirred();
		vi.advanceTimersByTime(SPACING_MS * 2);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said).toEqual([
			"V8's gc threw (unknown flavor), so the host won't collect when quiet",
		]);
	});

	it("stops, collecting nothing after", () => {
		const { collect, quiet } = counted();
		quiet.stirred();
		quiet.stop();
		vi.advanceTimersByTime(SPACING_MS);
		expect(collect).not.toHaveBeenCalled();
	});
});

describe("the tool calls a conversation runs", () => {
	it("counts each start until its end, apart for each conversation", () => {
		const tools = runningTools();
		tools.heard("a", "tool_execution_start");
		tools.heard("a", "tool_execution_start");
		tools.heard("b", "tool_execution_start");
		tools.heard("a", "message_update");
		tools.heard("a", "tool_execution_end");
		expect([tools.running("a"), tools.running("b")]).toEqual([1, 1]);
		tools.heard("a", "tool_execution_end");
		expect(tools.running("a")).toBe(0);
	});

	it("ends what a run's end leaves, as an abort does", () => {
		const tools = runningTools();
		tools.heard("a", "tool_execution_start");
		tools.heard("a", "agent_end");
		expect(tools.running("a")).toBe(0);
	});

	it("forgets a conversation that has gone", () => {
		const tools = runningTools();
		tools.heard("a", "tool_execution_start");
		tools.forget("a");
		expect(tools.running("a")).toBe(0);
	});
});

describe("V8's last-resort collection", () => {
	it("runs in this process", () => {
		const collect = lastResortCollect();
		expect(collect).toBeTypeOf("function");
		expect(() => collect?.()).not.toThrow();
	});

	it.runIf(process.platform === "linux")("reads this process's Pss", () => {
		expect(pssBytes()).toBeGreaterThan(MB);
	});
});
