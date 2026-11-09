/**
 * A reload hands a session's background jobs to the runtime it starts:
 * they keep running, and their results are said through the new `pi`.
 * The reload is played as pi plays one (see tests/support/job-runtime.ts).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CARRY_MS,
	type HandOff,
	park,
	takeParked,
} from "../../../extensions/job-workflow/carry.ts";
import type { JobSession } from "../../../extensions/job-workflow/lifecycle.ts";
import {
	findJobHost,
	type JobFinished,
	type JobHost,
	jobStopOf,
	onJobFinished,
} from "../../../lib/jobs/index.ts";
import {
	forgetParkedJobs,
	jobRuntime,
	reloadJobs,
} from "../../support/job-runtime.ts";

/** A message the outbox sent, as pi's `message_end` carries it. */
const landed = (text: string) => ({
	message: { role: "user", content: [{ type: "text", text }] },
});

async function startedOn(events: EventBus) {
	const first = jobRuntime(events);
	await first.fire("session_start", { reason: "startup" });
	return { first, host: findJobHost(events) as JobHost };
}

afterEach(() => {
	vi.useRealTimers();
	forgetParkedJobs();
});

describe("a reload", () => {
	it("leaves a running job running, and the new runtime says its result", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build .#kernel" });

		const next = await reloadJobs(events, first);
		expect(job.signal.aborted, "a reload leaves the job running").toBe(false);

		job.finish({ summary: "exited 0 after 50 minutes" });
		expect(first.said).toEqual([]);
		expect(next.said).toHaveLength(1);
		expect(next.said[0]).toContain(`[${job.id}]`);
		expect(next.said[0]).toContain("exited 0 after 50 minutes");
	});

	it("makes the new runtime the host, holding the carried job", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		host.start({ kind: "shell", label: "nix build .#kernel" });

		await reloadJobs(events, first);
		const now = findJobHost(events);
		expect(now).toBeDefined();
		expect(now?.pending?.()).toBe(1);
		// Numbering carries on, so a new job's tag never repeats a carried one's.
		expect(now?.start({ kind: "shell", label: "cargo build" }).id).toBe("j2");
	});

	it("says a result that was waiting when it came", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		first.state.busy = true;
		host
			.start({ kind: "subagent", label: "three lanes" })
			.finish({ summary: "all three agreed" });
		expect(first.said).toEqual([]);

		const next = await reloadJobs(events, first);
		expect(next.said).toHaveLength(1);
		expect(next.said[0]).toContain("all three agreed");
	});

	it("says a result that came while nobody held the jobs, once a runtime takes them", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "sleep 60" });
		await first.fire("session_shutdown", { reason: "reload" });
		first.invalidate();

		job.finish({ summary: "exited 0" });
		const next = jobRuntime(events);
		await next.fire("session_start", { reason: "reload" });
		expect(next.said).toHaveLength(1);
		expect(next.said[0]).toContain("exited 0");
	});

	it("says each job's end on the bus once, after the new runtime takes over", async () => {
		const events = createEventBus();
		const ended: JobFinished[] = [];
		onJobFinished(events, (finished) => ended.push(finished));
		const { first, host } = await startedOn(events);
		const early = host.start({ kind: "shell", label: "a", toolCallId: "c1" });
		const late = host.start({ kind: "shell", label: "b", toolCallId: "c2" });
		await first.fire("session_shutdown", { reason: "reload" });
		first.invalidate();

		early.finish({ summary: "done" });
		expect(ended).toEqual([]);
		const next = jobRuntime(events);
		await next.fire("session_start", { reason: "reload" });
		late.finish({ summary: "done" });
		expect(ended.map((finished) => finished.toolCallId)).toEqual(["c1", "c2"]);
	});

	it("takes the jobs from a runtime pi replaced without making it stale", async () => {
		// Two reloads that overlap both shut down the same old runtime, so
		// the one the first starts is replaced and never made stale. On 24
		// October its host stayed first on the bus: it held the carried
		// jobs, the new runtime's list said there were none, and a result
		// nobody marked as seen was said again every 30 seconds.
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "run-subtests vm-desktop" });
		await first.fire("session_shutdown", { reason: "reload" });
		first.invalidate();
		const second = jobRuntime(events);
		await second.fire("session_start", { reason: "reload" });

		const third = jobRuntime(events);
		await third.fire("session_start", { reason: "reload" });

		expect(await third.tool("jobs", { action: "list" })).toContain(job.id);
		job.finish({ summary: "exited 0" });
		findJobHost(events)
			?.start({ kind: "reload", label: "the reload you asked for" })
			.finish({ summary: "Reloaded, as asked." });
		expect(second.said).toEqual([]);
		expect(third.said).toHaveLength(1);
		expect(third.said[0]).toContain("exited 0");
		await third.fire("message_end", landed(third.said[0] ?? ""));
		await third.fire("agent_settled");
		expect(third.said).toHaveLength(2);
		expect(third.said[1]).toContain("Reloaded, as asked.");
		await third.fire("message_end", landed(third.said[1] ?? ""));
		await third.fire("agent_settled");
		expect(third.said).toHaveLength(2);
	});

	it("leaves another session's live jobs where they are", async () => {
		const events = createEventBus();
		const other = jobRuntime(events, "s2");
		await other.fire("session_start", { reason: "startup" });
		const job = findJobHost(events)?.start({ kind: "shell", label: "x" });

		const mine = jobRuntime(events, "s1");
		await mine.fire("session_start", { reason: "reload" });

		expect(await mine.tool("jobs", { action: "list" })).toMatch(
			/No background work/,
		);
		expect(await other.tool("jobs", { action: "list" })).toContain(
			job?.id ?? "?",
		);
	});

	it("carries the jobs through one reload after another", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build" });
		const second = await reloadJobs(events, first);
		const third = await reloadJobs(events, second);

		job.finish({ summary: "exited 0" });
		expect(second.said).toEqual([]);
		expect(third.said).toHaveLength(1);
		third.fire("message_end", landed(third.said[0] ?? ""));
		expect(findJobHost(events)?.pending?.()).toBe(0);
	});

	it("stops the jobs when no runtime takes them in time", async () => {
		vi.useFakeTimers();
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build" });
		await first.fire("session_shutdown", { reason: "reload" });
		first.invalidate();

		vi.advanceTimersByTime(CARRY_MS - 1);
		expect(job.signal.aborted, "the job runs until its carry time is up").toBe(
			false,
		);
		vi.advanceTimersByTime(1);
		expect(jobStopOf(job.signal)).toBe("session");
	});

	it("leaves another session's jobs alone, for their wait to stop", async () => {
		vi.useFakeTimers();
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build" });

		const other = await reloadJobs(events, first, "s2");
		expect(findJobHost(events)?.pending?.()).toBe(0);
		job.finish({ summary: "exited 0" });
		expect(other.said).toEqual([]);
		vi.advanceTimersByTime(CARRY_MS);
		expect(jobStopOf(job.signal)).toBe("session");
	});
});

describe("what a reload takes over", () => {
	// 9 November: adopting kept the parking runtime's own outbox, so a
	// process ran the outbox of whichever version first built it, and the
	// steer #1101 added reached no session started before it (N3Q98W).
	const pi = {} as ExtensionAPI;
	const ctx = {} as ExtensionContext;
	const session = (name: string) => ({ name }) as unknown as JobSession;

	it("is a hand-off the taking code builds its own session around", () => {
		const handed = { jobs: {}, waiting: [], unsaid: [] } as unknown as HandOff;
		const adopted: string[] = [];
		park({
			session: "s1",
			adopt: () => {
				adopted.push("adopted");
				return session("old");
			},
			stop: () => {},
			handOff: () => handed,
		});

		const taken = takeParked("s1", pi, ctx, (given) =>
			given === handed ? session("new") : session("wrong"),
		);

		expect({ taken, adopted }).toEqual({
			taken: session("new"),
			adopted: [],
		});
	});

	it("is the old session adopted whole, from code that can't hand off", () => {
		park({ session: "s1", adopt: () => session("old"), stop: () => {} });

		const taken = takeParked("s1", pi, ctx, () => session("new"));

		expect(taken).toEqual(session("old"));
	});

	it("says a job's result through the newest runtime after two hand-offs", async () => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const waiting = host.start({ kind: "shell", label: "cargo test" });
		const running = host.start({ kind: "shell", label: "nix build" });
		first.state.busy = true;
		waiting.finish({ summary: "finished while busy" });
		first.state.busy = false;

		const second = await reloadJobs(events, first);
		const third = await reloadJobs(events, second);
		running.finish({ summary: "exited 0" });
		for (let i = 0; i < 3; i++) {
			await third.fire("message_end", landed(third.said.at(-1) ?? ""));
			await third.fire("agent_settled");
		}

		expect(third.said.join("\n")).toContain("finished while busy");
		expect(first.said.join("\n")).not.toContain("exited 0");
		expect(second.said.join("\n")).not.toContain("exited 0");
		expect(third.said.join("\n")).toContain("exited 0");
		expect(findJobHost(events)?.pending?.()).toBe(0);
	});
});

describe("any other end of the session", () => {
	it.each([
		"new",
		"resume",
		"fork",
		"quit",
	])("stops its jobs on %s", async (reason) => {
		const events = createEventBus();
		const { first, host } = await startedOn(events);
		const job = host.start({ kind: "shell", label: "nix build" });
		await first.fire("session_shutdown", { reason });
		expect(jobStopOf(job.signal)).toBe("session");
	});
});
