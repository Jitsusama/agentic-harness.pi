/** When an open answers for its conversation's first words, as pi's prompt and durable each say. */
import { describe, expect, it } from "vitest";
import { firstWordsHeld } from "../../../host/engine/first-words.ts";

/** A promise with its settling handed out, for the test to decide when. */
function later() {
	let resolve = () => {};
	let reject = (_error: unknown) => {};
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** Whether `promise` has settled by the time pending work has run. */
async function answered(promise: Promise<void>): Promise<boolean> {
	let settled = false;
	promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return settled;
}

/** The first words sent, with pi's disposition for them and each wait left to the test. */
function sent(disposition?: "started" | "queued" | "handled") {
	const prompting = later();
	const admitted = later();
	const taken = later();
	const held = firstWordsHeld({
		prompting: prompting.promise,
		admitted: admitted.promise,
		taken: taken.promise,
		started: () => disposition === "started",
	});
	return { held, prompting, admitted, taken };
}

describe("a conversation's first words", () => {
	it("are answered for once durable holds them", async () => {
		const words = sent("started");
		words.admitted.resolve();
		expect(await answered(words.held), "durable committed them").toBe(true);
	});

	it("are answered for once a run pi started for them is over", async () => {
		const words = sent("started");
		words.prompting.resolve();
		expect(await answered(words.held), "pi's run ended").toBe(true);
	});

	it("wait for durable when pi only queued them behind a run under way", async () => {
		// pi answers a prompt it queued at once, before the run holding it reaches durable.
		const words = sent("queued");
		words.prompting.resolve();
		expect(await answered(words.held), "only queued").toBe(false);

		words.admitted.resolve();
		expect(await answered(words.held), "now held").toBe(true);
	});

	it("wait for durable when pi put them off while a run settled", async () => {
		// pi answers a prompt made while it tells extensions a run settled at once, saying nothing of it.
		const words = sent();
		words.prompting.resolve();
		expect(await answered(words.held), "only put off").toBe(false);

		words.admitted.resolve();
		expect(await answered(words.held), "now held").toBe(true);
	});

	it("are answered for once pi took them as a command", async () => {
		const words = sent("handled");
		words.taken.resolve();
		expect(await answered(words.held), "a command").toBe(true);
	});

	it("fail as pi's prompt fails", async () => {
		const words = sent();
		words.prompting.reject(new Error("no model"));
		await expect(words.held).rejects.toThrow("no model");
	});
});
