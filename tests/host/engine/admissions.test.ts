/** When the agent says durable holds the words it was watching for, whichever way durable took them. */
import { describe, expect, it } from "vitest";
import { Admissions } from "../../../host/engine/hosted-agent/admissions.ts";
import type { DurableBinding } from "../../../host/engine/hosted-agent/binding.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";
import {
	MessageQueue,
	type QueuedMessage,
} from "../../../host/engine/queue.ts";

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
		const watch = admissions.watch();
		queued(admissions, followUp, words("first"));
		watch.told("queued");
		expect(await outcome(watch.held)).toBe("held");
	});

	it("are held though durable took them before pi said it queued them", async () => {
		// pi says it queued words only after an await, by when durable may have them.
		const { admissions, followUp } = admitting();
		const watch = admissions.watch();
		queued(admissions, followUp, words("first"));
		expect(await outcome(watch.held), "not yet told which").toBe("waiting");
		watch.told("queued");
		expect(await outcome(watch.held)).toBe("held");
	});

	it("are held once a prompt carrying them is committed", async () => {
		const { admissions } = admitting();
		const watch = admissions.watch();
		watch.told("started");
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first]);
		expect(await outcome(watch.held)).toBe("held");
	});

	it("are not held by a prompt of words given before them", async () => {
		const { admissions, followUp } = admitting();
		const left = words("left from before");
		followUp.enqueue({ hostId: "left", message: left });
		const watch = admissions.watch();
		watch.told("started");
		admissions.given([words("first")]);
		admissions.committed([left]);
		expect(await outcome(watch.held)).toBe("waiting");
	});

	it("are not held by another's words given before them", async () => {
		// An extension may send words of its own while pi is still taking the first.
		const { admissions } = admitting();
		const watch = admissions.watch();
		const other = words("from an extension");
		admissions.given([other]);
		admissions.committed([other]);
		expect(await outcome(watch.held), "another's words").toBe("waiting");

		watch.told("started");
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first]);
		expect(await outcome(watch.held), "the first words").toBe("held");
	});

	it("are watched for no more once the watcher stops", async () => {
		// A watch nobody waits on would otherwise take the next words anyone gives.
		const { admissions } = admitting();
		const stopping = new AbortController();
		const watch = admissions.watch(stopping.signal);
		watch.told("started");
		stopping.abort();
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first]);
		expect(await outcome(watch.held)).toBe("refused");
	});

	it("are watched for no more once pi handled them", async () => {
		// Words an input handler or a command took reach no agent.
		const { admissions } = admitting();
		const watch = admissions.watch();
		watch.told("handled");
		const other = words("from an extension");
		admissions.given([other]);
		admissions.committed([other]);
		expect(await outcome(watch.held)).toBe("refused");
	});

	it("are refused as the prompt carrying them is", async () => {
		const { admissions } = admitting();
		const watch = admissions.watch();
		watch.told("started");
		const first = words("first");
		admissions.given([first]);
		admissions.committed([first], new Error("durable refused the prompt"));
		expect(await outcome(watch.held)).toBe("refused");
	});

	it("are refused once pi drops them before durable held them", async () => {
		const { admissions, followUp } = admitting();
		const watch = admissions.watch();
		const first = words("first");
		followUp.enqueue({ hostId: "first", message: first });
		admissions.given([first]);
		watch.told("queued");
		admissions.withdraw(followUp.clear());
		expect(await outcome(watch.held)).toBe("refused");
	});
});
