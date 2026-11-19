/**
 * An ask of the person to end a machine's sessions, in a reply, an ask
 * or a look, is refused while the node says others are live there, and
 * when it can't say; anything else goes as it was.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { sessionEndingInterceptor } from "../../../extensions/session-ending-interceptor/index.ts";
import { setSessionMode } from "../../../lib/guardian/policy.ts";
import type { NodeSession } from "../../../lib/mesh/node.ts";
import { type FakePi, fakePi } from "../../support/fake-pi.ts";

const SELF = "self-session";
const GUARD = "no-session-ending-ask-while-live";

const ctx = { sessionManager: { getSessionId: () => SELF } };

const someoneOn = (machine: string, state: NodeSession["state"] = "idle") => [
	{ id: "other", address: "EWUL44", machine, state },
	{ id: SELF, address: "0IM95G", machine: "optimus", state: "busy" as const },
];

let node: NodeSession[] | undefined;
let asked: number;
let pi: FakePi;

beforeEach(() => {
	node = someoneOn("equilibrius");
	asked = 0;
	pi = fakePi();
	setSessionMode(GUARD, "block");
	sessionEndingInterceptor({
		sessions: async () => {
			asked++;
			return node;
		},
		here: () => "optimus",
	})(pi);
});

const handler = (event: string) => {
	const [one] = pi.recorded.handlers.get(event) ?? [];
	if (!one) throw new Error(`nothing listens for ${event}`);
	return one;
};

const call = (toolName: string, input: unknown) =>
	handler("tool_call")(
		{ type: "tool_call", toolName, toolCallId: "c1", input },
		ctx,
	);

const reply = (...content: object[]) =>
	handler("message_end")(
		{
			type: "message_end",
			message: { role: "assistant", content, stopReason: "stop" },
		},
		ctx,
	);

const text = (said: string) => ({ type: "text", text: said });

describe("an ask tool call", () => {
	it("is refused when its prompt asks for a log-out on a machine others are on", async () => {
		const verdict = await call("ask", {
			questions: [
				{
					id: "q",
					prompt: "Could you log out of macOS on equilibrius to pair the card?",
					options: [{ value: "done", label: "Done" }],
				},
			],
		});

		expect(verdict).toMatchObject({ block: true });
		expect(JSON.stringify(verdict)).toContain("EWUL44 (idle)");
	});

	it("is refused when an option is the act itself", async () => {
		const verdict = await call("ask", {
			questions: [
				{
					id: "q",
					prompt: "The new kernel is in. What now?",
					options: [
						{ value: "now", label: "Reboot equilibrius now" },
						{ value: "later", label: "Later" },
					],
				},
			],
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("goes ahead when only the asker is on the machine", async () => {
		node = someoneOn("equilibrius", "ended");
		const verdict = await call("ask", {
			questions: [
				{ id: "q", prompt: "Please reboot equilibrius.", options: [] },
			],
		});

		expect(verdict).toBeUndefined();
	});

	it("goes ahead without asking the node when nothing could be an ask", async () => {
		const verdict = await call("ask", {
			questions: [{ id: "q", prompt: "Which colour?", options: [] }],
		});

		expect(verdict).toBeUndefined();
		expect(asked).toBe(0);
	});
});

describe("a show_person call", () => {
	it("is refused when what it asks is a session-ending act", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The pairing steps",
			why: "The card pairs at the login window.",
			ask: "Log out and pair the card, then say how it went",
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("is refused for a choice that is one", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The kernel",
			ask: "Say when",
			choices: ["Restart the laptop now", "Tomorrow"],
		});

		expect(verdict).toMatchObject({ block: true });
	});

	it("goes ahead when its why only mentions a reboot that happened", async () => {
		const verdict = await call("show_person", {
			kind: "page",
			target: "https://example.com",
			title: "The mic",
			why: "It stopped after the last reboot.",
			ask: "Nothing, just to see",
		});

		expect(verdict).toBeUndefined();
	});
});

describe("another tool's call", () => {
	it("goes as it was, whatever it says", async () => {
		expect(
			await call("bash", { command: "echo please reboot" }),
		).toBeUndefined();
		expect(asked).toBe(0);
	});
});

describe("a reply", () => {
	it("is withheld while others are live where it asks, and the model is told why", async () => {
		const call = { type: "toolCall", id: "t1", name: "read", arguments: {} };
		const answer = await reply(
			text("Done with the guard."),
			text("Please log out of macOS on equilibrius now."),
			call,
		);

		const message = (answer as { message: { content: object[] } }).message;
		expect(JSON.stringify(message.content)).not.toContain("log out of macOS");
		expect(message.content).toContainEqual(call);
		const [note] = pi.recorded.sent;
		expect(JSON.stringify(note)).toContain("EWUL44 (idle)");
	});

	it("is withheld when the node can't be read", async () => {
		node = undefined;
		const answer = await reply(text("Reboot optimus when you can."));

		expect(answer).toBeDefined();
		expect(JSON.stringify(pi.recorded.sent)).toContain("couldn't be read");
	});

	it("goes as it was when it asks nothing", async () => {
		expect(
			await reply(text("A log-out on equilibrius ended five sessions.")),
		).toBeUndefined();
		expect(pi.recorded.sent).toEqual([]);
	});

	it("goes as it was when the guard is off, said to the person", async () => {
		setSessionMode(GUARD, "off");

		expect(
			await reply(text("Please log out of macOS on equilibrius.")),
		).toBeUndefined();
	});

	it("leaves the person's and the tools' messages alone", async () => {
		const answer = await handler("message_end")(
			{
				type: "message_end",
				message: { role: "user", content: [text("Please reboot optimus.")] },
			},
			ctx,
		);

		expect(answer).toBeUndefined();
	});
});
