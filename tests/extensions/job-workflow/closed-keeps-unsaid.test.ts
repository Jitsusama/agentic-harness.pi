/**
 * A session that ends with a job's result still waiting to be said
 * writes it to its log, and the next start of the conversation says it.
 *
 * On 15 November a pi took up a carried call, found its end on its
 * first look, and was replaced by a reopen within the minute: the
 * result sat in the outbox, the close dropped it, and the take-up's
 * record kept the next start from taking it up again, so nothing ever
 * said how the call ended.
 */

import { EventEmitter } from "node:events";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import { CARRIED_ENTRY } from "../../../extensions/job-workflow/moved.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { findJobHost } from "../../../lib/jobs/index.ts";

/** Just enough of pi and a session, its log the entries it appends. */
function activate(log: unknown[], id = "s1") {
	const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
	const events = createEventBus();
	const said: string[] = [];
	const session = { busy: false };
	const pi = {
		events,
		on: (name: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: (text: string) => said.push(text),
		appendEntry: (customType: string, data: unknown) =>
			log.push({ type: "custom", customType, data }),
	};
	const ctx = {
		hasUI: true,
		isIdle: () => !session.busy,
		sessionManager: { getBranch: () => log, getSessionId: () => id },
		ui: {
			setStatus: () => {},
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI, { signals: new EventEmitter() });
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? [])
			await withSession(id, () => handler(event, ctx));
	};
	return { events, said, session, fire };
}

/** Whether a log entry is the custom entry `type`. */
function isCustom(entry: unknown, type: string): boolean {
	return (
		typeof entry === "object" &&
		entry !== null &&
		"customType" in entry &&
		entry.customType === type
	);
}

describe("a session closing with a result unsaid", () => {
	it("writes it to its log, and the next start says it", async () => {
		const log: unknown[] = [];
		const first = activate(log);
		await first.fire("session_start", { reason: "startup" });
		first.session.busy = true;
		findJobHost(first.events)
			?.start({ kind: "shell", label: "merge-net needs" })
			.finish({ summary: "`merge-net needs` exited 0 after 4m" });
		expect(first.said, "a busy session waits to say it").toEqual([]);

		await first.fire("session_shutdown", { reason: "quit" });
		expect(
			log.filter((entry) => isCustom(entry, CARRIED_ENTRY)),
			"kept for whoever opens the conversation next",
		).toHaveLength(1);

		const next = activate(log);
		await next.fire("session_start", { reason: "startup" });
		expect(next.said.join("\n")).toContain(
			"`merge-net needs` exited 0 after 4m",
		);
	});

	it("writes nothing when every result was said", async () => {
		const log: unknown[] = [];
		const first = activate(log);
		await first.fire("session_start", { reason: "startup" });
		await first.fire("session_shutdown", { reason: "quit" });
		expect(log, "an empty outbox leaves no record").toEqual([]);
	});
});
