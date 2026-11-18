/** When the agent says durable holds the words it was watching for, whichever way durable took them. */
import { describe, expect, it } from "vitest";
import { Admissions } from "../../../host/engine/hosted-agent/admissions.ts";
import type { DurableBinding } from "../../../host/engine/hosted-agent/binding.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";
import { MessageQueue, type QueuedMessage } from "../../../host/engine/queue.ts";

/** A person's words, each a distinct message as pi makes one. */
function words(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	} as unknown as AgentMessage;
}

/** Admissions over a durable that takes every queued word, as a run under way does. */
function admitting() {
	let next = 0;
	const durable = {
		conversation: {
			submit: async () => {
				next += 1;
				return { id: next };
			},
		},
		context: {},
		abortSubmission: async () => "aborted",
	} as unknown as DurableBinding;
	const steering = new MessageQueue("one-at-a-time");
	const followUp = new MessageQueue("one-at-a-time");
	return { admissions: new Admissions(durable, steering, followUp), followUp };
}

/** Whether `promise` has settled, and how, by the time pending work has run. */
async function outcome(promise: Promise<void>): Promise<string> {
	let said = "waiting";
	promise.then(
		() => {
			said = "held";
		},
		() => {
			said = "refused";
		},
	);
	for (let turn = 0; turn < 5; turn += 1)
		await new Promise((resolve) => setTimeout(resolve, 0));
	return said;
}

/** Queue `message` as pi does, admitted to the run under way. */
function queued(
	admissions: Admissions,
	queue: MessageQueue,
	message: AgentMessage,
): QueuedMessage {
	const item: QueuedMessage = { hostId: String(Math.random()), message };
	queue.enqueue(item);
	admissions.given([message]);
	admissions.admitQueued(item, "followUp");
	return item;
}

describe("the words the agent watches for", () => {
	it("are held once queued behind a run that takes them, which commits no prompt", async () => {
		const { admissions, followUp } = admitting();
		const held = admissions.whenNextHeld();
		queued(admissions, followUp, words("first"));
		expect(await outcome(held)).toBe("held");
	});

	it("are held once a prompt carrying them is committed", async () => {
		const { admissions } = admitting();
		const held = admissions.whenNextHeld();
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first]);
		expect(await outcome(held)).toBe("held");
	});

	it("are not held by a prompt of words given before them", async () => {
		const { admissions, followUp } = admitting();
		const left = words("left from before");
		followUp.enqueue({ hostId: "left", message: left });
		const held = admissions.whenNextHeld();
		admissions.given([words("first")]);
		admissions.committed([left]);
		expect(await outcome(held)).toBe("waiting");
	});

	it("are refused as the prompt carrying them is", async () => {
		const { admissions } = admitting();
		const held = admissions.whenNextHeld();
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first], new Error("durable refused the prompt"));
		expect(await outcome(held)).toBe("refused");
	});

	it("are refused once pi drops them before durable held them", async () => {
		const { admissions, followUp } = admitting();
		const held = admissions.whenNextHeld();
		const first = words("first");
		followUp.enqueue({ hostId: "first", message: first });
		admissions.given([first]);
		admissions.withdraw(followUp.clear());
		expect(await outcome(held)).toBe("refused");
	});
});
