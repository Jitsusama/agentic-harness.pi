/**
 * A line the person types during a run is answered at once: pi's working
 * line says what it waits on, and calls that can move hear of it. A line
 * from an extension, or one queued to follow the run, changes nothing.
 *
 * Driven through pi's own event bus and the events pi emits, with pi's
 * queue of steered lines kept as AgentSession keeps it: a line is queued
 * once every input handler has heard it, as one user message in the
 * words pi expands it to with its images after, and dropped from the
 * queue on pi's own match before message_start is emitted.
 */

import {
	contentText,
	type ImageContent,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import jobWorkflow from "../../../extensions/job-workflow/index.ts";
import { onSteered, steerWaiting } from "../../../lib/jobs/steer.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A user message, as pi starts one when it reads it. */
const userMessage = (
	text: string,
	images: readonly ImageContent[] = [],
): UserMessage => ({
	role: "user",
	content: [{ type: "text", text }, ...images],
	timestamp: Date.now(),
});

/** Just enough of pi and a session to drive the extension. */
async function started() {
	const handlers = new Map<string, Handler[]>();
	const events = createEventBus();
	const working: (string | undefined)[] = [];
	/** pi's steering and follow-up queues, as their texts. */
	const queued: string[] = [];
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
		hasPendingMessages: () => queued.length > 0,
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
	/** pi queues a message, in the words it reads it in, to read later. */
	const queue = (text: string, images: readonly ImageContent[] = []) => {
		queued.push(text);
		return userMessage(text, images);
	};
	/**
	 * The person types `text` while the run streams: every input handler
	 * hears it, then pi queues it in the words it expands it to.
	 */
	const type = async (
		text: string,
		{
			images = [],
			expanded = text,
		}: { images?: ImageContent[]; expanded?: string } = {},
	) => {
		await fire("input", { ...steer(text), images });
		return queue(expanded, images);
	};
	/** pi reads a message: drops it from its queue, then says it starts. */
	const read = async (message: UserMessage) => {
		const at = queued.indexOf(contentText(message.content, ""));
		if (at !== -1) queued.splice(at, 1);
		await fire("message_start", { message });
	};
	await fire("session_start", { reason: "startup" });
	await fire("agent_start");
	return { events, working, fire, queue, type, read };
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

/** A pasted screenshot, as pi attaches one to a typed line. */
const screenshot: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

/** The block pi expands `/skill:name args` into, with the skill's text. */
const skillBlock = (name: string, body: string, args: string) => {
	const block = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
};

describe("a line typed while a call runs", () => {
	it("says the call it waits on", async () => {
		const { working, fire, type } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await type("stop that");

		expect(working.at(-1)).toBe("Your message is read once bash ends");
	});

	it("says how many calls it waits on when several run", async () => {
		const { working, fire, type } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_start", call("c2", "codemode"));
		await type("stop that");

		expect(working.at(-1)).toBe("Your message is read once 2 calls end");
	});

	it("says the reply once the calls have ended", async () => {
		const { working, fire, type } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await type("stop that");
		await fire("tool_execution_end", call("c1", "bash"));

		expect(working.at(-1)).toBe("Your message is read once this reply ends");
	});

	it("tells calls that can move", async () => {
		const { events, type } = await started();
		let heard = 0;
		onSteered(events, () => heard++);
		await type("stop that");

		expect(heard).toBe(1);
		expect(steerWaiting(events), "a line waits to be read").toBe(true);
	});
});

describe("a typed line once pi reads it", () => {
	it("gives pi back its own working line", async () => {
		const { events, working, type, read } = await started();
		await read(await type("stop that"));

		expect(working.at(-1)).toBeUndefined();
		expect(steerWaiting(events), "no line waits").toBe(false);
	});

	// pi may read another message first: a peer's steer, or the run's prompt.
	it("keeps waiting while pi reads another message first", async () => {
		const { events, working, queue, type, read } = await started();
		const peers = queue("a peer's words read first");
		const typed = await type("stop that");
		await read(peers);

		expect(steerWaiting(events), "behind another message").toBe(true);
		expect(working.at(-1), "behind another message").toMatch(/^Your message/);
		await read(typed);
		expect(steerWaiting(events), "once its own words are read").toBe(false);
		expect(working.at(-1)).toBeUndefined();
	});

	it("gives it back when the run ends without reading it", async () => {
		const { events, working, fire, type } = await started();
		await type("stop that");
		await fire("agent_settled", { aborted: true });

		expect(working.at(-1)).toBeUndefined();
		expect(steerWaiting(events), "no line waits").toBe(false);
	});
});

describe("a typed line pi reads in other words", () => {
	it("lets go a line sent with an image", async () => {
		const { events, working, type, read } = await started();
		await read(await type("what is this?", { images: [screenshot] }));

		expect(steerWaiting(events), "read with its image").toBe(false);
		expect(working.at(-1)).toBeUndefined();
	});

	it("lets go a line pi expands as a skill, though more waits", async () => {
		const { events, working, queue, type, read } = await started();
		const typed = await type("/skill:code-tdd-guide write the test first", {
			expanded: skillBlock(
				"code-tdd-guide",
				"# TDD\n\nRed, green, refactor.",
				"write the test first",
			),
		});
		queue("a peer's words read after");
		await read(typed);

		expect(steerWaiting(events), "read as its skill").toBe(false);
		expect(working.at(-1)).toBeUndefined();
	});

	it("lets go a template's line once pi holds nothing more", async () => {
		const { events, working, fire, type, read } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		const typed = await type("/review 2360", {
			expanded: "Review pull request 2360 and say what blocks it.",
		});
		await fire("tool_execution_end", call("c1", "bash"));
		await read(typed);

		expect(steerWaiting(events), "read as its template").toBe(false);
		expect(working.at(-1)).toBeUndefined();
	});

	it("keeps a template's line waiting while pi reads another first", async () => {
		const { events, fire, queue, type, read } = await started();
		const peers = queue("a peer's words read first");
		await fire("tool_execution_start", call("c1", "bash"));
		const typed = await type("/review 2360", {
			expanded: "Review pull request 2360 and say what blocks it.",
		});
		await fire("tool_execution_end", call("c1", "bash"));
		await read(peers);

		expect(steerWaiting(events), "behind another message").toBe(true);
		await read(typed);
		expect(steerWaiting(events), "once pi holds nothing more").toBe(false);
	});

	// pi queues a line only once every extension's input handler is done.
	it("keeps waiting when pi reads its prompt before queuing the line", async () => {
		const { events, fire, queue, read } = await started();
		await fire("input", steer("/review 2360"));
		await read(userMessage("the run's own prompt"));

		expect(steerWaiting(events), "not yet queued").toBe(true);
		const typed = queue("Review pull request 2360 and say what blocks it.");
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_end", call("c1", "bash"));
		await read(typed);
		expect(steerWaiting(events), "once pi holds nothing more").toBe(false);
	});

	// A later extension may handle the line, so pi never queues it.
	it("keeps a line pi never reads waiting until the run settles", async () => {
		const { events, working, fire, read } = await started();
		await fire("input", steer("stop that"));
		await read(userMessage("the run's own prompt"));
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_end", call("c1", "bash"));

		expect(steerWaiting(events), "never read").toBe(true);
		await fire("agent_settled", { aborted: false });
		expect(steerWaiting(events), "once the run settles").toBe(false);
		expect(working.at(-1)).toBeUndefined();
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
		const { working, fire, read } = await started();
		await fire("tool_execution_start", call("c1", "bash"));
		await fire("tool_execution_end", call("c1", "bash"));
		await read(userMessage("hi"));

		expect(working).toEqual([]);
	});
});
