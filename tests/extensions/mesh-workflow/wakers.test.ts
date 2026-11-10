import { describe, expect, it } from "vitest";
import {
	meshWakers,
	type Own,
} from "../../../extensions/mesh-workflow/wakers.ts";
import type { Lease } from "../../../lib/mesh/lease.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import type { WaitingItem } from "../../../lib/mesh/waiting.ts";

const NOW = Date.parse("2026-11-10T04:00:00.000Z");

function message(
	over: Partial<Message> & Pick<Message, "id" | "from">,
): Message {
	return {
		v: 1,
		at: new Date(NOW - 10 * 60 * 1000).toISOString(),
		to: ["@B"],
		intent: "question",
		text: "may I?",
		pid: 1,
		...over,
	};
}

function item(id: string, session: string): WaitingItem {
	return {
		id,
		title: "say yes",
		why: "his call",
		minutes: 2,
		window: null,
		quest: "Q",
		ready: true,
		doneWhen: { by: "person" },
		owner: { session, address: "A" },
	};
}

const NOBODY: Own = {
	session: "s-a",
	addresses: ["A"],
	leases: [],
	messages: [],
	aliases: (address) => [address],
	items: [],
};

describe("what of a peer's own on the mesh will wake it", () => {
	it("names nothing when it has nothing out", () => {
		expect(meshWakers(NOBODY, NOW)).toEqual([]);
	});

	it("names a hold it waits on, but not one lapsed", () => {
		const wait = (subject: string, until: number): Lease => ({
			kind: "wait",
			subject,
			since: new Date(NOW - 60_000).toISOString(),
			until: new Date(until).toISOString(),
		});
		const own = {
			...NOBODY,
			leases: [wait("h1", NOW + 60_000), wait("h2", NOW - 1)],
		};

		expect(meshWakers(own, NOW)).toEqual(["a hold it waits on [h1]"]);
	});

	it("names a question it asked still unanswered, not one answered or another's", () => {
		const own = {
			...NOBODY,
			messages: [
				message({ id: "1", from: "A" }),
				message({ id: "2", from: "A" }),
				message({ id: "3", from: "B", to: ["@A"], intent: "fyi", re: "2" }),
				message({ id: "4", from: "C" }),
			],
		};

		expect(meshWakers(own, NOW)).toEqual(["a question [1] awaiting B"]);
	});

	it("names a Needs You item it filed, not another session's", () => {
		const own = {
			...NOBODY,
			items: [item("look", "s-a"), item("other", "s-b")],
		};

		expect(meshWakers(own, NOW)).toEqual([
			"a Needs You item, look, not yet settled",
		]);
	});
});
