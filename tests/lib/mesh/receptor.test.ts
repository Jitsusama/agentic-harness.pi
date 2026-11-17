import { describe, expect, it } from "vitest";
import { noted } from "../../../extensions/mesh-workflow/delivery.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { servedFrom } from "../../../lib/mesh/node.ts";
import {
	RECEPTOR_SIGNAL,
	readsAsReceptor,
	vouchedOnly,
} from "../../../lib/mesh/receptor.ts";

/** A message from `from`, to the outside network a receptor says on. */
function from(sender: string, id: string): Message {
	return {
		v: 1,
		id,
		at: "2026-11-16T23:00:00.000Z",
		from: sender,
		to: ["outside.github"],
		intent: "fyi",
		text: "github: 3 asked of you, up from 1; 5 today",
		pid: 1,
	};
}

describe("readsAsReceptor", () => {
	// The fixtures of Jitsusama/mycelium #267's speaks_as_receptor tests,
	// case for case, so the harness and the node can't drift apart.
	it("takes every name that could be read as a receptor's cell", () => {
		for (const name of [
			"github@kestrel",
			"slack@skiff",
			"GitHub@kestrel",
			"git-hub@kestrel",
			" slack @kestrel",
			"github\u200b@kestrel",
			"g\u0456thub@kestrel",
			"github@kestrel.",
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
		const dropped: string[] = [];
		const shown = await vouchedOnly(
			[planted, said, plain],
			async () => new Set(["2-said"]),
			(message) => dropped.push(message.id),
		);
		expect(
			shown.map((one) => one.id),
			"only what the node said, and what names no receptor, is shown",
		).toEqual(["2-said", "3-plain"]);
		expect(dropped, "the planted one is said as dropped").toEqual([
			"1-planted",
		]);
	});

	it("drops every one under a receptor's name when no node answers", async () => {
		const dropped: string[] = [];
		const shown = await vouchedOnly(
			[from("GitHub@kestrel", "1-planted")],
			async () => undefined,
			(message) => dropped.push(message.id),
		);
		expect(shown, "a silent node vouched for a receptor's name").toEqual([]);
		expect(dropped, "the drop went unsaid").toEqual(["1-planted"]);
	});

	it("never asks the node when no name reads as a receptor's", async () => {
		let asked = 0;
		const plain = from("WCJQSG", "1-plain");
		const shown = await vouchedOnly(
			[plain],
			async () => {
				asked++;
				return new Set();
			},
			() => undefined,
		);
		expect(shown, "a plain message was held back").toEqual([plain]);
		expect(asked, "the node was asked about no receptor").toBe(0);
	});
});

describe("servedFrom", () => {
	it("reads the message ids a node's get answer holds", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{ key: "message:2-said", kind: "message" },
				{ key: "receptor:github", kind: "receptor" },
			],
		});
		expect(
			[...(servedFrom(line) ?? [])],
			"a served message's id was misread",
		).toEqual(["2-said"]);
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
