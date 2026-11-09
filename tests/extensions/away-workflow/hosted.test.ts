/** Hosted away records and follow-up turns stay with their conversation. */
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUIET_MS } from "../../../extensions/away-workflow/carry-on.ts";
import awayWorkflow from "../../../extensions/away-workflow/index.ts";
import { sessionEnv, withSession } from "../../../lib/core/session/index.ts";
import {
	type MachineWord,
	machineAwayPath,
	publishMachineWord,
	readMachineWord,
} from "../../../lib/internal/away/machine.ts";
import {
	decide,
	hold,
	onAwayChange,
	planProgress,
	setProgressSource,
	snapshot,
	stoppingFromOutside,
	takeStoppedFromOutside,
} from "../../../lib/internal/away/state.ts";
import {
	onWants,
	type WantEvent,
} from "../../../lib/internal/session/wants.ts";
import { announceJobHost, type Job } from "../../../lib/jobs/index.ts";
import { fakePi } from "../../support/fake-pi.ts";
import { installTestHost } from "../../support/session-host.ts";

const watches = vi.hoisted(
	() => new Set<(word: MachineWord | undefined) => void>(),
);
vi.mock("../../../lib/internal/away/machine.ts", async (original) => ({
	...(await original<typeof import("../../../lib/internal/away/machine.ts")>()),
	watchMachineWord: (listener: (word: MachineWord | undefined) => void) => {
		watches.add(listener);
		return () => watches.delete(listener);
	},
}));

let installed: ReturnType<typeof installTestHost>;
const cleanup: (() => unknown)[] = [];
beforeEach(() => {
	installed = installTestHost();
	rmSync(machineAwayPath(), { force: true });
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	installed.dispose();
	watches.clear();
	vi.useRealTimers();
	rmSync(machineAwayPath(), { force: true });
});

function activate(id: string) {
	const pi = fakePi();
	const ctx = {
		cwd: `/${id}`,
		hasUI: false,
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => id,
			getBranch: () =>
				pi.recorded.entries.map((entry) => ({ type: "custom", ...entry })),
		},
		ui: { notify: vi.fn() },
	};
	const wants: WantEvent[] = [];
	cleanup.push(onWants(pi.events, (want) => wants.push(want)));
	const jobs: { summary?: string; withdrawn: boolean }[] = [];
	cleanup.push(
		announceJobHost(pi.events, {
			start: (): Job => {
				const job = {
					summary: undefined as string | undefined,
					withdrawn: false,
				};
				jobs.push(job);
				return {
					id: `j${jobs.length}`,
					signal: new AbortController().signal,
					finish: (outcome) => {
						job.summary = outcome.summary;
					},
					onDelivered: () => {},
					withdraw: () => {
						job.withdrawn = true;
						return true;
					},
				};
			},
		}),
	);
	withSession(id, () => awayWorkflow(pi));
	const fire = async (event: string, data: unknown = {}) => {
		for (const handler of pi.recorded.handlers.get(event) ?? []) {
			await withSession(id, () => handler(data, ctx));
		}
	};
	cleanup.push(() => fire("session_shutdown"));
	return {
		pi,
		ctx,
		wants,
		jobs,
		fire,
		async away(goal: string) {
			const tool = pi.recorded.tools.find((tool) => tool.name === "away");
			if (!tool) throw new Error("away tool not registered");
			await withSession(id, () =>
				tool.execute("t1", { goal }, undefined, undefined, ctx as never),
			);
		},
		async runEnds(text: string) {
			await fire("agent_end", {
				messages: [
					{
						role: "assistant",
						stopReason: "stop",
						content: [
							{ type: "toolCall", id: "t1", name: "read", arguments: {} },
							{ type: "text", text },
						],
					},
				],
			});
			await fire("agent_settled");
		},
	};
}

/** Deliberately dispatch outside any conversation, as an external file event can. */
function followMachine() {
	for (const watch of watches) watch(readMachineWord());
}

describe("hosted away lifecycle", () => {
	it("shares standing without a viewer, never sharing goals, holds or decisions", async () => {
		const a = activate("a");
		const b = activate("b");
		await a.fire("session_start");
		await b.fire("session_start");
		await a.away("A goal");
		expect(readMachineWord()?.away).toEqual({
			since: withSession("a", snapshot).since,
		});
		followMachine();
		expect(withSession("b", snapshot)).toEqual({
			since: withSession("a", snapshot).since,
			held: [],
			decided: [],
		});
		await b.away("B goal");
		followMachine();
		withSession("a", () => {
			hold({ guard: "guard", title: "A approval" });
			decide({ question: "A question", answer: "A answer", by: "model" });
		});
		expect(withSession("b", snapshot)).toMatchObject({
			goal: "B goal",
			held: [],
			decided: [],
		});
		expect(b.wants).toEqual([]);
		expect(a.wants.map((want) => want.said)).toEqual([
			"Holds a call for you: A approval",
		]);
		withSession("b", () => hold({ guard: "guard", title: "B approval" }));
		await a.fire("session_shutdown");
		await installed.host.close("a", "finished");
		expect(watches.size).toBe(1);
		withSession("b", () => hold({ guard: "guard", title: "B next approval" }));
		expect(withSession("b", snapshot).held.map((call) => call.title)).toEqual([
			"B approval",
			"B next approval",
		]);
		expect(b.pi.recorded.entries.at(-1)?.data).toMatchObject({
			goal: "B goal",
		});
	});

	it("keeps Done and send-back-to-work state local, and withdraws only A's jobs", async () => {
		const a = activate("a");
		const b = activate("b");
		await a.fire("session_start");
		await b.fire("session_start");
		await a.away("A goal");
		followMachine();
		await b.away("B goal");
		await a.runEnds("Done: finished");
		await b.runEnds("More work remains");
		expect(a.jobs).toEqual([]);
		expect(b.jobs[0]?.summary).toContain("B goal");
		await a.runEnds("More A work");
		await a.fire("session_shutdown");
		await installed.host.close("a", "finished");
		expect(a.jobs[0]?.withdrawn, "A's shutdown withdraws A's nudge").toBe(true);
		expect(b.jobs[0]?.withdrawn, "A's shutdown leaves B's nudge pending").toBe(
			false,
		);
		await b.runEnds("Still working");
		expect(b.jobs).toHaveLength(2);
	});

	it("publishes a hosted typed return to every watcher and accepts a plain pi return", async () => {
		const a = activate("a");
		const b = activate("b");
		await a.fire("session_start");
		await b.fire("session_start");
		// Earlier than the typed return, matching a real absence.
		publishMachineWord({
			since: "2026-01-01T00:00:00.000Z",
			goal: "Plain pi goal",
		});
		followMachine();
		expect(withSession("a", snapshot).goal).toBeUndefined();
		await a.fire("input", { source: "interactive", text: "back" });
		expect(readMachineWord()?.away).toBeUndefined();
		followMachine();
		expect(withSession("b", snapshot).since).toBeUndefined();
		publishMachineWord({ since: "2026-01-01T00:00:00.000Z" });
		followMachine();
		publishMachineWord(undefined);
		followMachine();
		expect(withSession("a", snapshot).since).toBeUndefined();
		expect(withSession("b", snapshot).since).toBeUndefined();
	});

	it("carries on without a viewer using only its own environment and question want", async () => {
		vi.useFakeTimers();
		const a = activate("a");
		const b = activate("b");
		await a.fire("session_start");
		await b.fire("session_start");
		withSession("a", () => sessionEnv(a.ctx).set("PI_CARRY_ON", "off"));
		for (const id of ["a", "b"]) {
			withSession(id, () =>
				setProgressSource(() => ({ document: id, done: 0, total: 2 })),
			);
		}
		await a.runEnds("More work");
		await b.runEnds("Which option do you want?");
		expect(b.wants.map((want) => want.said)).toEqual([
			"Which option do you want?",
		]);
		expect(a.wants).toEqual([]);
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		expect(a.jobs).toEqual([]);
		expect(b.jobs).toHaveLength(1);
		expect(b.jobs[0]?.summary).toContain("b");
	});

	it("isolates progress and outside-stop marks, including a captured listener disposer", async () => {
		const heardA = vi.fn();
		const heardB = vi.fn();
		const stopA = withSession("a", () => onAwayChange(heardA));
		withSession("b", () => {
			onAwayChange(heardB);
			setProgressSource(() => ({ document: "B plan", done: 1, total: 3 }));
		});
		withSession("a", () => {
			setProgressSource(() => ({ document: "A plan", done: 2, total: 4 }));
			stoppingFromOutside();
			hold({ guard: "g", title: "A hold" });
		});
		expect(heardA).toHaveBeenCalledOnce();
		expect(heardB).not.toHaveBeenCalled();
		expect(
			withSession("b", takeStoppedFromOutside),
			"A's outside stop does not mark B",
		).toBe(false);
		expect(
			withSession("a", takeStoppedFromOutside),
			"A takes its own outside stop",
		).toBe(true);
		stopA();
		await installed.host.close("a", "finished");
		expect(withSession("b", planProgress)?.document).toBe("B plan");
		withSession("b", () => hold({ guard: "g", title: "B hold" }));
		expect(heardB).toHaveBeenCalledOnce();
	});
});
