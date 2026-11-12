/**
 * A line the person types during a run is answered at once: pi's working
 * line says what it waits on, and calls that can move hear of it. A line
 * from an extension, or one queued to follow the run, changes nothing.
 *
 * Driven through pi's own event bus and the events pi emits.
 */

import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import { onSteered, steerWaiting } from "../../../lib/jobs/steer.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Just enough of pi and a session to drive the extension. */
async function started() {
	const handlers = new Map<string, Handler[]>();
	const events = createEventBus();
	const working: (string | undefined)[] = [];
	const pi = {
		events,
		on: (name: string, handler: Handler) => {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendUserMessage: () => {},
	};
	const ctx = {
		hasUI: true,
		isIdle: () => false,
		ui: {
			setStatus: () => {},
			setWorkingMessage: (text?: string) => working.push(text),
			theme: { fg: (_colour: string, text: string) => text },
			notify: () => {},
		},
	};
	jobWorkflow(pi as unknown as ExtensionAPI);
	const fire = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	await fire("session_start", { reason: "startup" });
	await fire("agent_start");
	return { events, working, fire };
}

/** A line the person typed while the run streams. */
const steer = (text: string) => ({
	text,
	source: "interactive",
	streamingBehavior: "steer",
});

const call = (toolCallId: string, toolName: string) => ({
	toolCallId,
	toolName,
	args: {},
});

/** A user message starting, as pi emits one when it reads a line. */
const userMessage = (text: string) => ({
	message: { role: "user", content: [{ type: "text", text }] },
});

describe("a line typed while a call runs", () => {
	it("says the call it waits on", async () => {
		const { working, fire } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("input", steer("stop that"));

		expect(working.at(-1)).toBe("Your message is read once bash ends");
	});

	it("says how many calls it waits on when several run", async () => {
		const { working, fire } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_start", call("c2", "codemode"));
		await fire("input", steer("stop that"));

		expect(working.at(-1)).toBe("Your message is read once 2 calls end");
	});

	it("says the reply once the calls have ended", async () => {
		const { working, fire } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("input", steer("stop that"));
		await fire("tool_execution_end", call("c1", "bash"));

		expect(working.at(-1)).toBe("Your message is read once this reply ends");
	});

	it("tells calls that can move", async () => {
		const { events, fire } = await started();
		let heard = 0;
		onSteered(events, () => heard++);
		await fire("input", steer("stop that"));

		expect(heard).toBe(1);
		expect(steerWaiting(events), "a line waits to be read").toBe(true);
	});
});

describe("a typed line once pi reads it", () => {
	it("gives pi back its own working line", async () => {
		const { events, working, fire } = await started();
		await fire("input", steer("stop that"));
		await fire("message_start", userMessage("stop that"));

		expect(working.at(-1)).toBeUndefined();
		expect(steerWaiting(events), "no line waits").toBe(false);
	});

	it("gives it back when the run ends without reading it", async () => {
		const { events, working, fire } = await started();
		await fire("input", steer("stop that"));
		await fire("agent_settled", { aborted: true });

		expect(working.at(-1)).toBeUndefined();
		expect(steerWaiting(events), "no line waits").toBe(false);
	});
});

describe("a line that isn't the person's, or isn't waiting", () => {
	it("changes nothing when an extension sends it", async () => {
		const { events, working, fire } = await started();
		await fire("input", { ...steer("a mesh message"), source: "extension" });

		expect(working).toEqual([]);
		expect(steerWaiting(events), "no line waits").toBe(false);
	});

	it("changes nothing when it is queued to follow the run", async () => {
		const { events, working, fire } = await started();
		await fire("input", { ...steer("later"), streamingBehavior: "followUp" });

		expect(working).toEqual([]);
		expect(steerWaiting(events), "no line waits").toBe(false);
	});

	it("leaves pi's working line alone as calls come and go", async () => {
		const { working, fire } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_end", call("c1", "bash"));
		await fire("message_start", userMessage("hi"));

		expect(working).toEqual([]);
	});
});
