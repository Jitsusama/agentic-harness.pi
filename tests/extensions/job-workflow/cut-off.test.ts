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
import { describe, expect, it } from "vitest";
import {
	CUT_OFF_ENTRY,
	cutOffIn,
	endedRecord,
	resumeText,
	watchSignals,
} from "../../../extensions/job-workflow/cut-off.ts";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import { findJobHost } from "../../../lib/jobs/index.ts";

const AT = "2026-10-24T17:54:34.617Z";

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
	});
});

/** Just enough of pi and a session for the end and the restore. */
function activate(branch: unknown[], signals: EventEmitter) {
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
		sessionManager: { getBranch: () => branch, getSessionId: () => "s1" },
		ui: {
			setStatus: () => {},
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI, { signals });
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
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

	it("listens for signals only while its session runs", async () => {
		const signals = new EventEmitter();
		const pi = activate([], signals);
		await pi.fire("session_start", { reason: "startup" });
		expect(signals.listenerCount("SIGTERM")).toBe(1);
		await pi.fire("session_shutdown", { reason: "reload" });
		expect(signals.listenerCount("SIGTERM")).toBe(0);
		expect(signals.listenerCount("SIGHUP")).toBe(0);
		expect(watchSignals(signals).signalled()).toBe(false);
	});
});
