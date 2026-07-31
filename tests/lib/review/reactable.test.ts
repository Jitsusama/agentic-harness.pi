/**
 * Addressing a comment.
 *
 * Reacting used to need a provider's internal id that no listing printed, so
 * the only way to name a comment was to guess. These pin the address that
 * replaced it, and the property the whole scheme rests on: the same comment
 * gets the same address whether it was numbered from the whole conversation or
 * from the half of it a listing happened to hold.
 */

import { describe, expect, it } from "vitest";
import type { Message, Thread } from "../../../lib/review/index.js";
import {
	findReactable,
	isReactableRefusal,
	reactableAddresses,
	reactables,
} from "../../../lib/review/index.js";

function comment(id: string, body = "a remark"): Message {
	return { id, author: { id: "reviewer@example.com" }, body };
}

function thread(id: string, comments: Message[]): Thread {
	return { id, resolved: false, stale: false, comments };
}

const threads = [
	thread("t-1", [comment("rc:1", "the opener"), comment("rc:2", "a reply")]),
	thread("t-2", [comment("rc:3", "another exchange")]),
];
const messages = [comment("ic:9", "a top-level remark")];

describe("numbering the comments on a change", () => {
	it("numbers thread remarks and top-level messages apart", () => {
		const found = reactables({ threads, messages });

		expect(found.map((one) => one.label)).toEqual([
			"[C1]",
			"[C2]",
			"[C3]",
			"[M1]",
		]);
	});

	it("gives a comment the same address from half the conversation", () => {
		// The property the scheme rests on. The threads listing holds no
		// messages and the messages listing holds no threads, and neither
		// should have to fetch the other half just to print an address. Two
		// families numbered apart is what makes that safe: sharing one space
		// would have shifted every message's number by however many thread
		// remarks the caller happened to have read.
		const fromThreadsOnly = reactables({ threads });
		const fromMessagesOnly = reactables({ messages });
		const fromEverything = reactables({ threads, messages });

		const addressOf = (among: ReturnType<typeof reactables>, id: string) =>
			among.find((one) => one.message.id === id)?.label;

		expect(addressOf(fromThreadsOnly, "rc:3")).toBe(
			addressOf(fromEverything, "rc:3"),
		);
		expect(addressOf(fromMessagesOnly, "ic:9")).toBe(
			addressOf(fromEverything, "ic:9"),
		);
	});

	it("keeps the thread a remark came from, for saying where it was", () => {
		const [first] = reactables({ threads });

		expect(first.thread?.id).toBe("t-1");
	});

	it("hands a renderer the addresses by comment id", () => {
		// A renderer walks the conversation in its own shape and should not
		// have to search a list for the label of the line it is on.
		const addresses = reactableAddresses(reactables({ threads, messages }));

		expect(addresses.get("rc:2")).toBe("[C2]");
		expect(addresses.get("ic:9")).toBe("[M1]");
	});
});

describe("resolving what somebody typed", () => {
	const among = reactables({ threads, messages });

	it("takes the address a listing printed", () => {
		const found = findReactable("[C2]", among);

		expect(isReactableRefusal(found) ? undefined : found.message.id).toBe(
			"rc:2",
		);
	});

	it("takes it without the brackets, and in either case", () => {
		for (const asked of ["C2", "c2", "[c2]"]) {
			const found = findReactable(asked, among);
			expect(isReactableRefusal(found) ? undefined : found.message.id).toBe(
				"rc:2",
			);
		}
	});

	it("still takes a provider's own id", () => {
		// A caller already holding one should not have to go and find its
		// number. The address exists because ids were undiscoverable, not
		// because they are wrong.
		const found = findReactable("ic:9", among);

		expect(isReactableRefusal(found) ? undefined : found.message.id).toBe(
			"ic:9",
		);
	});

	it("refuses a bare number rather than picking a family", () => {
		// It is ambiguous between the two, and guessing would react to the
		// wrong comment about half the time while looking like it worked.
		const found = findReactable("2", among);

		expect(isReactableRefusal(found) && found.reason).toMatch(/\[C2\].*\[M2\]/);
	});

	it("says how far the numbering goes when it is asked past the end", () => {
		const found = findReactable("[C9]", among);

		expect(isReactableRefusal(found) && found.reason).toContain("[C3]");
	});

	it("says the family is empty rather than naming a range of none", () => {
		const found = findReactable("[M1]", reactables({ threads }));

		expect(isReactableRefusal(found) && found.reason).toMatch(/no top-level/i);
	});

	it("names where the addresses come from when an id is unknown", () => {
		// Being told a value is wrong without being told where right values
		// come from leaves a caller guessing exactly as it was before.
		const found = findReactable("rc:404", among);

		expect(isReactableRefusal(found) && found.reason).toMatch(
			/read the threads or the messages/i,
		);
	});

	it("refuses nothing at all", () => {
		const found = findReactable("   ", among);

		expect(isReactableRefusal(found)).toBe(true);
	});
});
