import { describe, expect, it } from "vitest";
import { noted } from "../../../extensions/mesh-workflow/delivery.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { servedFrom } from "../../../lib/mesh/node.ts";
import {
	heedingNoReceptor,
	RECEPTOR_SIGNAL,
	readsAsReceptor,
	type Said,
	type Unvouched,
	unvouched,
	vouchedOnly,
} from "../../../lib/mesh/receptor.ts";
import type { Transport } from "../../../lib/mesh/transport.ts";

/** What a receptor says, as its node words it. */
const SIGNAL = "github: 3 asked of you, up from 1; 5 today";

/** A message from `from`, to the outside network a receptor says on. */
function from(sender: string, id: string, text = SIGNAL): Message {
	return {
		v: 1,
		id,
		at: "2026-11-16T23:00:00.000Z",
		from: sender,
		to: ["outside.github"],
		intent: "fyi",
		text,
		pid: 1,
	};
}

/** What a node serves of these messages, as they were written. */
function serving(...messages: Message[]): ReadonlyMap<string, Said> {
	return new Map(
		messages.map((one) => [one.id, { from: one.from, text: one.text }]),
	);
}

describe("readsAsReceptor", () => {
	// The fixtures of Jitsusama/mycelium's speaks_as_receptor tests, case
	// for case, so the harness and the node can't drift apart.
	it("takes every name that could be read as a receptor's cell", () => {
		for (const name of [
			"github@kestrel",
			"slack@skiff",
			"GitHub@kestrel",
			"git-hub@kestrel",
			"github2@kestrel",
			" slack @kestrel",
			"github\u200b@kestrel",
			"g\u0456thub@kestrel",
			"github@kestrel.",
			"github\uff20kestrel",
			"m\u0443celium@kestrel",
		]) {
			expect(
				readsAsReceptor(name),
				`${JSON.stringify(name)} reads as a receptor's cell but wasn't taken as one`,
			).toBe(true);
		}
	});

	it("leaves the node's own name, a person's and a session's alone", () => {
		for (const name of ["mycelium@kestrel", "WCJQSG", "joel", "4S6QRI"]) {
			expect(
				readsAsReceptor(name),
				`${JSON.stringify(name)} was taken as a receptor's cell`,
			).toBe(false);
		}
	});
});

describe("vouchedOnly", () => {
	it("drops one under a receptor's name the node doesn't serve, and says so", async () => {
		const planted = from("github@kestrel", "1-planted");
		const said = from("github@kestrel", "2-said");
		const plain = from("OSPR01", "3-plain");
		const dropped: [string, Unvouched][] = [];
		const shown = await vouchedOnly(
			[planted, said, plain],
			async () => serving(said),
			(message, why) => dropped.push([message.id, why]),
			[],
		);
		expect(
			shown.map((one) => one.id),
			"only what the node said, and what names no receptor, is shown",
		).toEqual(["2-said", "3-plain"]);
		expect(dropped, "the planted one is said as dropped, and why").toEqual([
			["1-planted", "unserved"],
		]);
	});

	it("drops one reusing a real signal's id with other words", async () => {
		const said = from("github@kestrel", "2-said");
		const forged = from("github@kestrel", "2-said", "github: 40 asked of you");
		const dropped: string[] = [];
		const shown = await vouchedOnly(
			[forged],
			async () => serving(said),
			(message) => dropped.push(message.id),
			[],
		);
		expect(shown, "words the node never said were vouched for").toEqual([]);
		expect(dropped, "the forged one went unsaid").toEqual(["2-said"]);
	});

	it("asks again for one the node serves a moment after it lands", async () => {
		const said = from("github@kestrel", "2-said");
		let asked = 0;
		const shown = await vouchedOnly(
			[said],
			async () => (++asked < 2 ? new Map() : serving(said)),
			() => undefined,
			[1],
		);
		expect(shown, "a signal the node serves late was lost").toEqual([said]);
		expect(asked, "the node was asked once more").toBe(2);
	});

	it("drops every one under a receptor's name when no node answers", async () => {
		const dropped: [string, Unvouched][] = [];
		const shown = await vouchedOnly(
			[from("GitHub@kestrel", "1-planted")],
			async () => undefined,
			(message, why) => dropped.push([message.id, why]),
			[1],
		);
		expect(shown, "a silent node vouched for a receptor's name").toEqual([]);
		expect(dropped, "the drop went unsaid, or said as unserved").toEqual([
			["1-planted", "unanswered"],
		]);
	});

	it("never asks the node when no name reads as a receptor's", async () => {
		let asked = 0;
		const plain = from("WCJQSG", "1-plain");
		const shown = await vouchedOnly(
			[plain],
			async () => {
				asked++;
				return new Map();
			},
			() => undefined,
		);
		expect(shown, "a plain message was held back").toEqual([plain]);
		expect(asked, "the node was asked about no receptor").toBe(0);
	});
});

describe("unvouched", () => {
	it("says whether the node answered", () => {
		expect(
			unvouched("github@kestrel", "1-x", "unanswered"),
			"a node that never answered was said to have refused",
		).toContain("no node answered");
		expect(
			unvouched("github@kestrel", "1-x", "unserved"),
			"a node that answered was said to be silent",
		).toContain("doesn't serve it as written");
	});
});

describe("heedingNoReceptor", () => {
	it("reads a receptor's name as nothing but as written", () => {
		const held = new Map([
			["1-signal", from("github@kestrel", "1-signal")],
			["2-plain", from("WCJQSG", "2-plain")],
		]);
		const folder = { read: (id: string) => held.get(id) } as Transport;
		const { transport, asWritten } = heedingNoReceptor(folder);
		expect(
			transport.read("1-signal"),
			"a plain read took a receptor's name",
		).toBe(undefined);
		expect(transport.read("2-plain")?.id, "a plain message went").toBe(
			"2-plain",
		);
		expect(asWritten("1-signal")?.id, "the vouching read lost it").toBe(
			"1-signal",
		);
	});
});

describe("servedFrom", () => {
	it("reads each served message's sender and text", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "message:2-said", from: "github@kestrel", text: SIGNAL },
				{ key: "message:3-bare" },
				{ key: "receptor:github", kind: "receptor" },
			],
		});
		expect(
			[...(servedFrom(line) ?? [])],
			"a served message was misread",
		).toEqual([["2-said", { from: "github@kestrel", text: SIGNAL }]]);
	});

	it("serves nothing for a refusal or a line it can't read", () => {
		expect(servedFrom('{"id": 2, "error": "no"}'), "a refusal served").toBe(
			undefined,
		);
		expect(servedFrom("not json"), "a garbled line served").toBe(undefined);
	});
});

describe("noted", () => {
	it("frames a receptor's signal as a fact to weigh, never orders", () => {
		expect(
			noted([from("github@kestrel", "2-said")]),
			"a receptor's signal reached the model unframed",
		).toContain(RECEPTOR_SIGNAL);
		expect(
			noted([from("WCJQSG", "1-plain")]),
			"a session's message was framed as a receptor's",
		).not.toContain(RECEPTOR_SIGNAL);
	});
});
