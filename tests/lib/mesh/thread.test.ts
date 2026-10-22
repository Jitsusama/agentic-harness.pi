/**
 * Threads: how messages answer and replace one another.
 */
import { describe, expect, it } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import {
	answers,
	depthOf,
	idNamed,
	mayReplace,
} from "../../../lib/mesh/thread.ts";

function message(id: string, over: Partial<Message> = {}): Message {
	return {
		v: 1,
		id,
		at: "2026-10-22T04:00:00.000Z",
		from: "WCJQSG",
		to: [ALL],
		intent: "question",
		text: "who has qemu?",
		pid: 7,
		...over,
	};
}

/** A mesh holding these messages, read by id. */
function holding(...messages: Message[]) {
	const byId = new Map(messages.map((one) => [one.id, one]));
	return (id: string) => byId.get(id);
}

describe("a reply's depth", () => {
	it("counts each answer down the thread", () => {
		const asked = message("1-WCJQSG-7-aaaaaaaa");
		const answer = message("2-LUQ49E-8-bbbbbbbb", { re: asked.id });
		const again = message("3-WCJQSG-7-cccccccc", { re: answer.id });
		const read = holding(asked, answer, again);

		expect(depthOf(asked, read)).toBe(0);
		expect(depthOf(answer, read)).toBe(1);
		expect(depthOf(again, read)).toBe(2);
	});

	it("counts what it can see of a thread it cannot read, and ends a loop", () => {
		const orphan = message("2-LUQ49E-8-bbbbbbbb", { re: "1-GONE-1-dddddddd" });
		expect(depthOf(orphan, holding(orphan))).toBe(1);

		const one = message("1-A-1-aaaaaaaa", { re: "2-B-1-bbbbbbbb" });
		const other = message("2-B-1-bbbbbbbb", { re: one.id });
		expect(depthOf(one, holding(one, other))).toBe(2);
	});
});

describe("an answer", () => {
	it("is to this peer when what it answers was sent by it", () => {
		const asked = message("1-LUQ49E-8-aaaaaaaa", { from: "LUQ49E", pid: 8 });
		const answer = message("2-WCJQSG-7-bbbbbbbb", { re: asked.id });
		const read = holding(asked, answer);

		expect(answers(answer, read, { addresses: ["LUQ49E"], pid: 1 })).toBe(true);
		expect(answers(answer, read, { addresses: ["P9R1KI"], pid: 8 })).toBe(true);
		expect(answers(answer, read, { addresses: ["P9R1KI"], pid: 1 })).toBe(
			false,
		);
		expect(answers(asked, read, { addresses: ["LUQ49E"], pid: 8 })).toBe(false);
	});
});

describe("a replacement", () => {
	it("may replace only what its own sender said before it", () => {
		const said = message("1-WCJQSG-7-aaaaaaaa");
		expect(mayReplace(message("2-WCJQSG-9-bbbbbbbb"), said)).toBe(true);
		expect(mayReplace(message("2-X-7-bbbbbbbb", { from: "X" }), said)).toBe(
			true,
		);
		expect(
			mayReplace(
				message("2-P9R1KI-3-bbbbbbbb", { from: "P9R1KI", pid: 3 }),
				said,
			),
		).toBe(false);
		expect(mayReplace(message("0-WCJQSG-7-bbbbbbbb"), said)).toBe(false);
	});
});

describe("an id as written", () => {
	const ids = ["1-WCJQSG-7-aaaaaaaa", "2-LUQ49E-8-bbbbbbbb", "3-X-1-ab"];

	it("names a message whole or by its last part", () => {
		expect(idNamed("2-LUQ49E-8-bbbbbbbb", ids)).toBe("2-LUQ49E-8-bbbbbbbb");
		expect(idNamed(" aaaaaaaa ", ids)).toBe("1-WCJQSG-7-aaaaaaaa");
	});

	it("names nothing it does not match exactly once", () => {
		expect(idNamed("cccccccc", ids)).toBeUndefined();
		expect(idNamed("", ids)).toBeUndefined();
		expect(idNamed("a", ids)).toBeUndefined();
		expect(idNamed("ab", [...ids, "4-Y-1-ab"])).toBeUndefined();
	});
});
