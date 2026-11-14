/**
 * A session the machine ended mid-work is given a turn when it comes
 * back, saying where it stopped and what died with it; one the person
 * stopped, or that was idle with nothing running, is left alone.
 *
 * On 24 October a reboot cut three sessions off: two mid-run, one
 * waiting on a fleet. Restored a minute later, all three sat idle until
 * another session asked them to carry on.
 */

import { EventEmitter } from "node:events";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	CUT_OFF_ENTRY,
	cutOffIn,
	endedRecord,
	resumeText,
	watchSignals,
} from "../../../extensions/job-workflow/cut-off.ts";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import { CARRIED_ENTRY } from "../../../extensions/job-workflow/moved.ts";
import { HOST_RESTARTING_EVENT } from "../../../lib/core/session/host.ts";
import {
	SESSION_STAMP_EVENT,
	withSession,
} from "../../../lib/core/session/index.ts";
import { processGlobal } from "../../../lib/internal/process-global.ts";
import { CRASH_SLOT } from "../../../lib/internal/session/crash-record.ts";
import { JOBS_CARRIED } from "../../../lib/jobs/host.ts";
import { findJobHost } from "../../../lib/jobs/index.ts";
import { installTestHost } from "../../support/session-host.ts";

const AT = "2026-10-24T17:54:34.617Z";

/** Hand an uncaught error to the crash slot's listener, as Node would. */
function crash(): void {
	const { listener } = processGlobal<{ listener?: unknown }>(
		CRASH_SLOT,
		() => ({}),
	);
	if (typeof listener !== "function") throw new Error("no crash listener");
	listener(new Error("ESRCH: no such process, write"), "uncaughtException");
}

const message = (role: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	timestamp: AT,
	message: { role, content: [{ type: "text", text: "x" }], ...extra },
});
const ended = (data: unknown) => ({
	type: "custom",
	customType: CUT_OFF_ENTRY,
	timestamp: AT,
	data,
});
const aborted = message("assistant", {
	stopReason: "error",
	errorMessage: "This operation was aborted",
});

describe("a session cut off when it ended", () => {
	it("is found from the record its end left, with nothing typed since", () => {
		const record = { at: Date.parse(AT), running: true, jobs: [] };
		expect(cutOffIn([message("user"), ended(record), aborted])).toEqual(record);
		// A prompt since, the person's or the turn this gives, has taken it up.
		expect(cutOffIn([ended(record), aborted, message("user")])).toBeUndefined();
	});

	it("is found from a log that stops mid-run when it was killed outright", () => {
		const killed = cutOffIn([
			message("user"),
			message("assistant", { stopReason: "toolUse" }),
			message("toolResult"),
		]);
		expect(killed).toEqual({ at: Date.parse(AT), running: true, jobs: [] });
		expect(
			cutOffIn([
				message("user"),
				message("assistant", { stopReason: "toolUse" }),
			]),
		).toBeDefined();
	});

	it("is not found where the run ended, the person stopped it, or nothing ran", () => {
		expect(cutOffIn([])).toBeUndefined();
		expect(
			cutOffIn([message("user"), message("assistant", { stopReason: "stop" })]),
		).toBeUndefined();
		// Escape: the run settles, aborted, before any end of the session.
		expect(cutOffIn([message("user"), aborted])).toBeUndefined();
	});

	it("is recorded only when a run or a job was under way", () => {
		expect(endedRecord(false, [], 1)).toBeUndefined();
		expect(endedRecord(true, [], 1)).toEqual({
			at: 1,
			running: true,
			jobs: [],
		});
		const fleet = { id: "j4", label: "5 subagents in v5poc-campaign-4" };
		expect(endedRecord(false, [fleet], 1)).toEqual({
			at: 1,
			running: false,
			jobs: [fleet],
		});
	});

	it("is told where it stopped and which jobs died with it", () => {
		const text = resumeText(
			{
				at: Date.parse(AT),
				running: false,
				jobs: [{ id: "j4", label: "5 subagents in v5poc-campaign-4" }],
			},
			() => "13:54",
		);
		expect(text).toContain("13:54");
		expect(text).toContain("j4");
		expect(text).toContain("5 subagents in v5poc-campaign-4");
		expect(text).toMatch(/never report/);
		expect(
			resumeText({ at: 0, running: true, jobs: [] }, () => "13:54"),
		).toMatch(/mid-run/);
		expect(text, "the orchestrator hears it came back").toMatch(
			/tell it once, by mesh/,
		);
	});
});

/** Just enough of pi and a session for the end and the restore. */
function activate(branch: unknown[], signals: EventEmitter, id = "s1") {
	const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
	const events = createEventBus();
	const said: string[] = [];
	const appended: { type: string; data: unknown }[] = [];
	const session = { busy: false };
	const pi = {
		events,
		on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: (text: string) => said.push(text),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !session.busy,
		sessionManager: { getBranch: () => branch, getSessionId: () => id },
		ui: {
			setStatus: () => {},
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI, { signals });
	const fire = async (name: string, event: unknown = {}) => {
		// Inside its conversation, as a host runs every hook.
		for (const handler of handlers.get(name) ?? [])
			await withSession(id, () => handler(event, ctx));
	};
	return { events, said, appended, session, fire };
}

describe("the job workflow, at a session's end and its return", () => {
	it("records a run under way when a signal ends the session", async () => {
		const signals = new EventEmitter();
		const pi = activate([], signals);
		await pi.fire("session_start", { reason: "startup" });
		pi.session.busy = true;
		// pi's own listener runs first and starts the shutdown at once, so
		// the handlers begin before the extension's listener hears it.
		const ending = pi.fire("session_shutdown", { reason: "quit" });
		signals.emit("SIGTERM");
		await ending;
		expect(pi.appended).toHaveLength(1);
		expect(pi.appended[0]?.type).toBe(CUT_OFF_ENTRY);
		expect(pi.appended[0]?.data).toMatchObject({ running: true, jobs: [] });
	});

	it("records the jobs that were running though the session sat idle", async () => {
		const signals = new EventEmitter();
		const pi = activate([], signals);
		await pi.fire("session_start", { reason: "startup" });
		findJobHost(pi.events)?.start({ kind: "subagent", label: "three lanes" });
		const ending = pi.fire("session_shutdown", { reason: "quit" });
		signals.emit("SIGHUP");
		await ending;
		expect(pi.appended[0]?.data).toMatchObject({
			running: false,
			jobs: [{ label: "three lanes" }],
		});
	});

	it("records the jobs that were running when an uncaught error ends the session", async () => {
		const pi = activate([], new EventEmitter(), "crashed");
		await pi.fire("session_start", { reason: "startup" });
		findJobHost(pi.events)?.start({ kind: "shell", label: "v3-prove" });
		crash();
		await pi.fire("session_shutdown", { reason: "quit" });
		expect(pi.appended, "one record, left as it died").toHaveLength(1);
		expect(pi.appended[0]?.type).toBe(CUT_OFF_ENTRY);
		expect(pi.appended[0]?.data).toMatchObject({
			running: false,
			jobs: [{ label: "v3-prove" }],
		});
	});

	it("stops hearing errors once its session ends", async () => {
		const pi = activate([], new EventEmitter(), "ended");
		await pi.fire("session_start", { reason: "startup" });
		findJobHost(pi.events)?.start({ kind: "shell", label: "left" });
		await pi.fire("session_shutdown", { reason: "quit" });
		const before = pi.appended.length;
		// Another session's writer keeps the listener in place to call.
		const other = activate([], new EventEmitter(), "other");
		await other.fire("session_start", { reason: "startup" });
		crash();
		expect(pi.appended.length, "an ended session records nothing").toBe(before);
		await other.fire("session_shutdown", { reason: "quit" });
	});

	it("records nothing for a quit the person asked for, or with nothing under way", async () => {
		const quit = activate([], new EventEmitter());
		await quit.fire("session_start", { reason: "startup" });
		quit.session.busy = true;
		await quit.fire("session_shutdown", { reason: "quit" });
		expect(quit.appended).toHaveLength(0);

		const signals = new EventEmitter();
		const idle = activate([], signals);
		await idle.fire("session_start", { reason: "startup" });
		signals.emit("SIGTERM");
		await idle.fire("session_shutdown", { reason: "quit" });
		expect(idle.appended).toHaveLength(0);
	});

	it("gives a restored session that was cut off a turn, once", async () => {
		const record = { at: Date.parse(AT), running: true, jobs: [] };
		const pi = activate(
			[message("user"), ended(record), aborted],
			new EventEmitter(),
		);
		await pi.fire("session_start", { reason: "startup" });
		expect(pi.said).toHaveLength(1);
		expect(pi.said[0]).toMatch(/mid-run/);

		const reloaded = activate(
			[message("user"), ended(record), aborted],
			new EventEmitter(),
		);
		await reloaded.fire("session_start", { reason: "reload" });
		expect(reloaded.said).toHaveLength(0);
	});

	it("holds the cut-off notice until the first prompt pi was started with has run", async () => {
		// Reopen Them All starts a session with its carry-on words; a
		// notice sent before pi submits them takes their turn, and pi
		// refuses the words (Y2YBTS [6508f771], 11-02 at 18:41).
		const argv = process.argv;
		process.argv = [
			argv[0] ?? "node",
			"pi",
			"--session",
			"s1",
			"--",
			"Carry on",
		];
		const uptime = vi.spyOn(process, "uptime").mockReturnValue(5);
		delete (globalThis as Record<symbol, unknown>)[
			Symbol.for("agentic-harness.pi/first-prompt")
		];
		try {
			const record = { at: Date.parse(AT), running: true, jobs: [] };
			const pi = activate(
				[message("user"), ended(record), aborted],
				new EventEmitter(),
			);
			await pi.fire("session_start", { reason: "startup" });
			expect(pi.said).toHaveLength(0);

			await pi.fire("input", { text: "Carry on", source: "interactive" });
			pi.session.busy = true;
			await pi.fire("agent_start");
			expect(pi.said).toHaveLength(0);
			pi.session.busy = false;
			await pi.fire("agent_settled");
			expect(pi.said).toHaveLength(1);
			expect(pi.said[0]).toMatch(/mid-run/);
		} finally {
			process.argv = argv;
			uptime.mockRestore();
		}
	});

	it("in a host, records a run under way when the host stamps it signalled", async () => {
		const host = installTestHost();
		try {
			const sigterms = process.listenerCount("SIGTERM");
			const sighups = process.listenerCount("SIGHUP");
			const signals = new EventEmitter();
			const pi = activate([], signals, "a");
			await pi.fire("session_start", { reason: "startup" });
			pi.session.busy = true;

			expect({
				source: signals.listenerCount("SIGTERM"),
				sigterms: process.listenerCount("SIGTERM"),
				sighups: process.listenerCount("SIGHUP"),
			}).toEqual({ source: 0, sigterms, sighups });

			pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "signalled" });
			await pi.fire("session_shutdown", { reason: "quit" });

			expect(pi.appended).toHaveLength(1);
			expect(pi.appended[0]?.data).toMatchObject({ running: true });
		} finally {
			host.dispose();
		}
	});

	it("in a host's restart, carries the bash calls to the next host and records only the rest cut off", async () => {
		const host = installTestHost();
		try {
			const pi = activate([], new EventEmitter(), "a");
			await pi.fire("session_start", { reason: "startup" });
			const work = {
				kind: "shell",
				keep: "/kept/one",
				pid: 4242,
				mark: "m1",
				startedAt: 0,
			};
			const jobs = findJobHost(pi.events);
			jobs?.start({
				kind: "shell",
				label: "make test",
				carry: { what: () => work, handed: () => {} },
			});
			jobs?.start({ kind: "subagent", label: "three lanes" });
			const said: unknown[] = [];
			pi.events.on(JOBS_CARRIED, (data) => said.push(data));

			pi.events.emit(HOST_RESTARTING_EVENT, { session: "a" });
			pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "signalled" });
			await pi.fire("session_shutdown", { reason: "quit" });

			expect(said).toEqual([
				{
					session: "a",
					jobs: [expect.objectContaining({ label: "make test", work })],
				},
			]);
			expect(pi.appended.map(({ type }) => type)).toEqual([
				CARRIED_ENTRY,
				CUT_OFF_ENTRY,
			]);
			expect(pi.appended[1]?.data).toMatchObject({
				jobs: [{ label: "three lanes" }],
			});
		} finally {
			host.dispose();
		}
	});

	it("in a host, carries nothing for a stop that isn't a restart", async () => {
		const host = installTestHost();
		try {
			const pi = activate([], new EventEmitter(), "a");
			await pi.fire("session_start", { reason: "startup" });
			findJobHost(pi.events)?.start({
				kind: "shell",
				label: "make test",
				carry: {
					what: () => ({
						kind: "shell",
						keep: "/kept/one",
						pid: 4242,
						mark: "m1",
						startedAt: 0,
					}),
					handed: () => {},
				},
			});
			// Another conversation's restart is not this one's.
			pi.events.emit(HOST_RESTARTING_EVENT, { session: "b" });
			pi.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "signalled" });
			await pi.fire("session_shutdown", { reason: "quit" });

			expect(pi.appended.map(({ type }) => type)).toEqual([CUT_OFF_ENTRY]);
		} finally {
			host.dispose();
		}
	});

	it("in a host, records nothing for a close, or another conversation's stop", async () => {
		const host = installTestHost();
		try {
			const closed = activate([], new EventEmitter(), "a");
			await closed.fire("session_start", { reason: "startup" });
			closed.session.busy = true;
			closed.events.emit(SESSION_STAMP_EVENT, { session: "a", how: "closed" });
			await closed.fire("session_shutdown", { reason: "quit" });

			const other = activate([], new EventEmitter(), "a");
			await other.fire("session_start", { reason: "startup" });
			other.session.busy = true;
			other.events.emit(SESSION_STAMP_EVENT, {
				session: "b",
				how: "signalled",
			});
			await other.fire("session_shutdown", { reason: "quit" });

			expect({
				closed: closed.appended.length,
				other: other.appended.length,
			}).toEqual({ closed: 0, other: 0 });
		} finally {
			host.dispose();
		}
	});

	it("listens for signals only while its session runs", async () => {
		const signals = new EventEmitter();
		const pi = activate([], signals);
		await pi.fire("session_start", { reason: "startup" });
		expect(signals.listenerCount("SIGTERM")).toBe(1);
		await pi.fire("session_shutdown", { reason: "reload" });
		expect(signals.listenerCount("SIGTERM")).toBe(0);
		expect(signals.listenerCount("SIGHUP")).toBe(0);
		expect(
			watchSignals(signals).signalled(),
			"a fresh watch reads no signal after the session shut down",
		).toBe(false);
	});
});
