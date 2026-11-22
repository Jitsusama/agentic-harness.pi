/**
 * The host's collection once it goes quiet: one last-resort collection
 * once no tool call or job runs and no viewer has typed or resized for
 * VIEWER_QUIET_MS, though conversations may be waiting on the model; at
 * most one each SPACING_MS, plus one owed after a park; none until
 * something stirs; one anyway once due CEILING_MS with work running;
 * none, said once, where V8 exposes no gc or its gc throws; none, said,
 * where the heap has grown so that the pause the last collections foretell
 * would hold the loop over a second. Fake timers stand in for the clock;
 * the last cases run V8's own collection and read this process's Pss.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CEILING_MS,
	lastResortCollect,
	PACE_KEPT_MS,
	PACE_WINDOW,
	processCode,
	processHeap,
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
		const heaps = [
			{
				used: 700 * MB,
				total: 760 * MB,
				external: 60 * MB,
				arrayBuffers: 9 * MB,
				spaces: [
					{ name: "old_space", used: 600 * MB, size: 640 * MB },
					{ name: "new_space", used: MB / 2, size: MB / 2 },
				],
			},
			{
				used: 150 * MB,
				total: 200 * MB,
				external: 40 * MB,
				arrayBuffers: 5 * MB,
				spaces: [
					{ name: "old_space", used: 100 * MB, size: 120 * MB },
					{ name: "large_object_space", used: 30 * MB, size: 40 * MB },
					{ name: "code_space", used: 20 * MB, size: 40 * MB },
					{ name: "new_space", used: MB / 5, size: MB / 2 },
				],
			},
		];
		const quiet = quietCollection({
			reading,
			collect,
			weigh: () => weighs.shift(),
			heap: () => heaps.shift(),
			code: () => ({ compiled: 18 * MB, bytecode: 6 * MB, source: 25 * MB }),
			report: (one) => said.push(one),
		});
		return { collect, said, quiet };
	}

	it("collects once a turn has settled, saying the pause, the Pss, heap and memory beside it before and after, each space it keeps, and the code and script source it holds", () => {
		const { collect, said, quiet } = counted();
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS - 1);
		expect(collect).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said).toEqual([
			expect.stringMatching(
				/^Collected while quiet in \d+ ms, Pss 812 MB to 214 MB, heap 700 of 760 MB to 150 of 200 MB \(old 100 of 120 MB, large object 30 of 40 MB, code 20 of 40 MB\), outside it 60 MB to 40 MB, of which array buffers 9 MB to 5 MB, code and metadata 18 MB, bytecode 6 MB, external script source 25 MB, read in \d+ ms, with 0 conversations waiting on the model$/,
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
			heap: () => undefined,
			code: () => undefined,
			report: (one) => said.push(one),
			clock: (() => {
				const reads = [0, 1240, 1240];
				return () => reads.shift() ?? 0;
			})(),
		});
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(said).toEqual([
			"Collected while quiet in 1240 ms, Pss unread, with 2 conversations waiting on the model; the loop held 1.2 s for it",
		]);
	});

	it("counts reading the code in the pause the loop held for", () => {
		const said: string[] = [];
		let now = 0;
		const quiet = quietCollection({
			reading: () => ({ tools: 0, jobs: 0, waiting: 0 }),
			collect: () => {
				now += 400;
			},
			weigh: () => undefined,
			heap: () => undefined,
			// V8 walks the heap to count its code, which can take longer.
			code: () => {
				now += 700;
				return { compiled: MB, bytecode: MB, source: MB };
			},
			report: (one) => said.push(one),
			clock: () => now,
		});
		quiet.stirred();
		vi.advanceTimersByTime(SETTLE_MS);
		expect(said[0]).toMatch(
			/^Collected while quiet in 1100 ms, .*, read in 700 ms, .*; the loop held 1\.1 s for it$/,
		);
	});

	/**
	 * A host whose heap uses `used()` and whose collections each take the
	 * next of `pauses` ms, collecting each time something stirs once spaced;
	 * a child's, forgetting its paces, where `forgetsPaces` says so.
	 */
	function paced(used: () => number, pauses: number[], forgetsPaces = false) {
		const collect = vi.fn();
		const code = vi.fn(() => ({ compiled: MB, bytecode: MB, source: MB }));
		const said: string[] = [];
		let now = 0;
		let reads = 0;
		const quiet = quietCollection({
			reading: () => ({ tools: 0, jobs: 0, waiting: 1 }),
			collect,
			weigh: () => undefined,
			heap: () => ({
				used: used(),
				total: used(),
				external: 0,
				arrayBuffers: 0,
				spaces: [],
			}),
			code,
			report: (one) => said.push(one),
			// Each collection reads the clock three times: before it, after
			// it, and after reading the code, which takes none here.
			clock: () => {
				reads += 1;
				if (reads % 3 === 2) now += pauses.shift() ?? 0;
				return now;
			},
			forgetsPaces,
		});
		const next = () => {
			quiet.stirred();
			vi.advanceTimersByTime(SPACING_MS);
		};
		return { collect, code, said, next };
	}

	it("leaves uncollected a heap whose pause would hold the loop over a second, saying why, and collects once it has fallen", () => {
		let used = 800 * MB;
		const { collect, code, said, next } = paced(() => used, [600, 450]);
		next();
		expect(collect).toHaveBeenCalledTimes(1);
		used = 1600 * MB;
		next();
		expect(collect).toHaveBeenCalledTimes(1);
		expect(
			code,
			"its code, which takes a walk of the heap, read only once collected",
		).toHaveBeenCalledTimes(1);
		expect(said[1]).toBe(
			"Left uncollected while quiet: the heap uses 1600 MB, which at 768 ms a GB, the slowest of the last 1 collections, would hold the loop about 1.2 s, past the 1 s a pause may take; with 1 conversations waiting on the model",
		);
		used = 1200 * MB;
		next();
		expect(collect).toHaveBeenCalledTimes(2);
		expect(said[2]).toMatch(/^Collected while quiet in 450 ms/);
	});

	it("foretells the pause by the slowest of its last collections, forgetting older ones", () => {
		let used = 500 * MB;
		// One at 1 ms a MB, then the rest of the window at half that.
		const fast = Array.from({ length: PACE_WINDOW }, () => 250);
		const { collect, said, next } = paced(() => used, [500, ...fast, 550]);
		for (let one = 0; one < PACE_WINDOW; one += 1) next();
		used = 1100 * MB;
		next();
		expect(collect).toHaveBeenCalledTimes(PACE_WINDOW);
		expect(said.at(-1)).toMatch(/^Left uncollected while quiet/);
		used = 500 * MB;
		next();
		used = 1100 * MB;
		next();
		expect(collect).toHaveBeenCalledTimes(PACE_WINDOW + 2);
		expect(said.at(-1)).toMatch(/^Collected while quiet in 550 ms/);
	});

	it("keeps a collection that has run past a second from running again at that heap", () => {
		const { collect, said, next } = paced(() => 900 * MB, [1100]);
		next();
		next();
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said[1]).toMatch(
			/^Left uncollected while quiet: the heap uses 900 MB, which at 1252 ms a GB/,
		);
	});

	it("forgets a child's slow pause after an hour, so one slowed by swap doesn't skip every look after", () => {
		let used = 300 * MB;
		// 1.1 s at 300 MB, as under swap, then 900 ms once it has passed.
		const { collect, said, next } = paced(() => used, [1100, 900], true);
		next();
		used = 1200 * MB;
		const lookups = PACE_KEPT_MS / SPACING_MS - 1;
		for (let one = 0; one < lookups; one += 1) next();
		expect(
			collect,
			"the slow pace rules within its hour",
		).toHaveBeenCalledTimes(1);
		next();
		expect(
			collect,
			"past its hour, with no pace kept, even a heap over a GB is collected to measure afresh",
		).toHaveBeenCalledTimes(2);
		expect(said.at(-1)).toMatch(/^Collected while quiet in 900 ms/);
	});

	it("keeps the shared host's slow pace past the hour, since its pause stalls every conversation", () => {
		const { collect, said, next } = paced(() => 300 * MB, [1100]);
		next();
		const lookups = PACE_KEPT_MS / SPACING_MS;
		for (let one = 0; one < lookups; one += 1) next();
		expect(collect).toHaveBeenCalledTimes(1);
		expect(said.at(-1)).toMatch(/^Left uncollected while quiet/);
	});

	it("forgets only a child's paces past their hour, keeping the later ones", () => {
		let used = 300 * MB;
		// One slow, as under swap, then two at half a ms a MB.
		const { collect, said, next } = paced(() => used, [1100, 50, 50], true);
		next();
		used = 100 * MB;
		next();
		next();
		expect(collect).toHaveBeenCalledTimes(3);
		used = 2400 * MB;
		const lookups = PACE_KEPT_MS / SPACING_MS - 2;
		for (let one = 0; one < lookups; one += 1) next();
		expect(collect).toHaveBeenCalledTimes(3);
		expect(
			said.at(-1),
			"the slow one gone at its hour, and the two after it still ruling",
		).toMatch(
			/^Left uncollected while quiet: the heap uses 2400 MB, which at 512 ms a GB, the slowest of the last 2 collections/,
		);
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

	it("reads this process's heap, each space it keeps and what it holds outside it", () => {
		const heap = processHeap();
		expect(heap.used).toBeGreaterThan(MB);
		expect(heap.total).toBeGreaterThanOrEqual(heap.used);
		expect(heap.external).toBeGreaterThanOrEqual(heap.arrayBuffers);
		expect(heap.spaces.map((space) => space.name)).toContain("old_space");
	});

	it("reads the code this process holds, each part of it", () => {
		const code = processCode();
		expect(code.compiled, "this file's compiled code").toBeGreaterThan(0);
		expect(code.bytecode, "this file's bytecode").toBeGreaterThan(0);
		expect(code.source, "node's built-in modules' source").toBeGreaterThan(0);
	});
});
