/**
 * A message's envelope, read leniently, and who it reaches.
 */
import { describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import {
	isHomeTo,
	type Message,
	messageFrom,
	reaches,
} from "../../../lib/mesh/message.ts";

const message = (over: Partial<Message> = {}): Message => ({
	v: 1,
	id: "1-WCJQSG-1-aaaa",
	at: "2026-10-21T22:00:00.000Z",
	from: "WCJQSG",
	to: [ALL],
	intent: "hold",
	text: "hold heavy builds",
	pid: 1,
	...over,
});

describe("an envelope", () => {
	it("reads what this version wrote", () => {
		expect(messageFrom(message())).toEqual(message());
	});

	it("ignores what it does not know, so a newer peer's message still reads", () => {
		const newer = { ...message(), v: 2, re: "0-X-1-bbbb", mood: "calm" };
		expect(messageFrom(newer)).toEqual({ ...message(), v: 2 });
	});

	it("reads an intent it does not know as an fyi", () => {
		expect(messageFrom({ ...message(), intent: "gossip" })?.intent).toBe("fyi");
		const { intent: _, ...none } = message();
		expect(messageFrom(none)?.intent).toBe("fyi");
	});

	it("is nothing when what it must have is missing", () => {
		const { text: _, ...textless } = message();
		expect(messageFrom(textless)).toBeUndefined();
		expect(messageFrom({ ...message(), to: [1] })).toBeUndefined();
		expect(messageFrom(null)).toBeUndefined();
	});
});

describe("who a message reaches", () => {
	const listener = { addresses: ["7M6JKG", "24B025FE"], groups: ["#harness"] };

	it("is every peer, for the machine's group", () => {
		expect(reaches(message(), listener, 2)).toBe(true);
	});

	it("is a peer, through any of its home groups", () => {
		expect(reaches(message({ to: ["@24B025FE"] }), listener, 2)).toBe(true);
		expect(reaches(message({ to: ["@OVAE1I"] }), listener, 2)).toBe(false);
		expect(isHomeTo(message({ to: ["@7M6JKG"] }), listener.addresses)).toBe(
			true,
		);
	});

	it("is the members of a group it went to", () => {
		expect(reaches(message({ to: ["#harness"] }), listener, 2)).toBe(true);
		expect(reaches(message({ to: ["#skynet"] }), listener, 2)).toBe(false);
	});

	it("is never its own sender, by address or by process", () => {
		expect(reaches(message({ from: "7M6JKG" }), listener, 2)).toBe(false);
		expect(reaches(message({ from: "CA6H2X", pid: 2 }), listener, 2)).toBe(
			false,
		);
	});
});
