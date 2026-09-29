/**
 * The job workflow says a background job's result once, when the
 * session can take it, and stops its jobs when the session ends.
 *
 * Driven through pi's own event bus and the events pi emits, with the
 * session's idleness under the test's control.
 */

import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import {
	findJobHost,
	type JobHost,
	jobStopOf,
} from "../../../lib/jobs/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Command {
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

/** Just enough of pi and a session to drive the extension. */
function activate(options: { choices?: (string | undefined)[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const events = createEventBus();
	const said: string[] = [];
	const status: (string | undefined)[] = [];
	const choices = [...(options.choices ?? [])];
	const session = { busy: false };
	const pi = {
		events,
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, command: Command) => {
			commands.set(name, command);
		},
		sendUserMessage: (text: string) => {
			said.push(text);
		},
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !session.busy,
		ui: {
			setStatus: (_key: string, text: string | undefined) => status.push(text),
			notify: () => {},
			select: async (
				_title: string,
				_options: string[],
			): Promise<string | undefined> => choices.shift(),
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { events, said, status, session, fire, commands, ctx };
}

/** A user message as pi's `message_end` carries it. */
const userMessage = (text: string) => ({
	message: { role: "user", content: [{ type: "text", text }] },
});

async function started() {
	const pi = activate();
	await pi.fire("session_start", { reason: "startup" });
	const host = findJobHost(pi.events);
	expect(host).toBeDefined();
	return { ...pi, host: host as JobHost };
}

describe("a background job's result", () => {
	it("is said as a prompt when the session is idle", async () => {
		const { host, said } = await started();
		const job = host.start({ kind: "subagent", label: "three lanes" });
		job.finish({ summary: "all three lanes agreed" });
		expect(said).toHaveLength(1);
		expect(said[0]).toContain("all three lanes agreed");
		expect(said[0]).toContain("three lanes");
	});

	it("waits for a run to settle", async () => {
		const { host, said, session, fire } = await started();
		session.busy = true;
		await fire("agent_start");
		host
			.start({ kind: "subagent", label: "lanes" })
			.finish({ summary: "done" });
		expect(said).toHaveLength(0);
		session.busy = false;
		await fire("agent_settled");
		expect(said).toHaveLength(1);
	});

	it("waits while the person's prompt is on its way", async () => {
		const { host, said, fire } = await started();
		await fire("input", { text: "hi", source: "interactive" });
		host
			.start({ kind: "subagent", label: "lanes" })
			.finish({ summary: "done" });
		expect(said).toHaveLength(0);
	});

	it("tells its producer once it is in the session", async () => {
		const { host, said, fire } = await started();
		const job = host.start({ kind: "subagent", label: "lanes" });
		let delivered = 0;
		job.onDelivered(() => delivered++);
		job.finish({ summary: "done" });
		expect(delivered).toBe(0);
		await fire("input", { text: said[0], source: "extension" });
		await fire("agent_start");
		await fire("message_end", userMessage(said[0] ?? ""));
		expect(delivered).toBe(1);
	});

	it("is said once, however often it is finished", async () => {
		const { host, said, session, fire } = await started();
		session.busy = true;
		const job = host.start({ kind: "subagent", label: "lanes" });
		job.finish({ summary: "first" });
		job.finish({ summary: "second" });
		session.busy = false;
		await fire("agent_settled");
		expect(said).toHaveLength(1);
		expect(said[0]).toContain("first");
		expect(said[0]).not.toContain("second");
	});

	it("is not taken as delivered when the model merely repeats it", async () => {
		const { host, said, fire } = await started();
		const job = host.start({ kind: "subagent", label: "lanes" });
		let delivered = 0;
		job.onDelivered(() => delivered++);
		job.finish({ summary: "done" });
		await fire("message_end", {
			message: {
				role: "assistant",
				content: [{ type: "text", text: said[0] }],
			},
		});
		expect(delivered).toBe(0);
	});
});

describe("when the session ends", () => {
	it("stops its jobs, says nothing more and stops answering", async () => {
		const { host, said, fire, events } = await started();
		const job = host.start({ kind: "subagent", label: "lanes" });
		await fire("session_shutdown", { reason: "quit" });
		expect(job.signal.aborted).toBe(true);
		expect(jobStopOf(job.signal)).toBe("session");
		job.finish({ summary: "too late" });
		expect(said).toHaveLength(0);
		expect(findJobHost(events)).toBeUndefined();
	});
});

describe("a job started on a host whose session has ended", () => {
	it("is stopped from the start, as the session's own were", async () => {
		const { host, fire } = await started();
		await fire("session_shutdown", { reason: "reload" });
		const late = host.start({ kind: "subagent", label: "lanes" });
		expect(jobStopOf(late.signal)).toBe("session");
	});
});

describe("the person stopping a job", () => {
	it("stops it from the job list and tells the model", async () => {
		const pi = activate({ choices: [undefined, "Stop it"] });
		await pi.fire("session_start", { reason: "startup" });
		const host = findJobHost(pi.events) as JobHost;
		const job = host.start({ kind: "subagent", label: "three lanes" });
		const jobs = pi.commands.get("jobs");
		expect(jobs).toBeDefined();
		// Escape on the list leaves it running.
		await jobs?.handler("", pi.ctx);
		expect(job.signal.aborted).toBe(false);
		// Picked, then confirmed; the list's first choice is the job.
		pi.ctx.ui.select = async (_title: string, options: string[]) =>
			options[0] === "Stop it" ? "Stop it" : options[0];
		await jobs?.handler("", pi.ctx);
		expect(job.signal.aborted).toBe(true);
		expect(jobStopOf(job.signal)).toBe("person");
		expect(pi.said).toHaveLength(1);
		expect(pi.said[0]).toMatch(/stopped/i);
		expect(pi.said[0]).toContain("three lanes");
	});
});
