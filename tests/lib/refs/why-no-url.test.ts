/**
 * Saying why a ref produced no link.
 *
 * This exists because of a silence. 621 of 667 stored Slack refs
 * produced no URL and nothing anywhere said so: the value was fine,
 * the type was fine, and the two disagreed about the shape. Written
 * from Slack API data a ref is `CHANNEL/TIMESTAMP`, because the API
 * never says which workspace you are talking to; read back, the
 * pattern wants `workspace/CHANNEL/pTIMESTAMP`. Only a ref parsed out
 * of a URL ever carried all three.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	clearRefTypes,
	registerBuiltinRefTypes,
	registerRefType,
	urlForRef,
	whyRefHasNoUrl,
} from "../../../lib/refs/index.js";

beforeEach(() => {
	clearRefTypes();
	registerBuiltinRefTypes();
});

describe("a Slack ref that will not become a link", () => {
	it("names the missing workspace and where it went", () => {
		const ref = {
			type: "slack-message",
			value: "C0AJY0FLK8Q/1780098828635099",
		};

		expect(urlForRef(ref)).toBeUndefined();
		const why = whyRefHasNoUrl(ref) ?? "";
		expect(why).toContain("no workspace");
		// The shape it needs, so the reader knows what to write.
		expect(why).toContain("workspace/CHANNEL/pTIMESTAMP");
		// And why it is missing, so they know this was not a typo.
		expect(why).toContain("API");
	});

	it("says nothing about a ref that does resolve", () => {
		const ref = {
			type: "slack-message",
			value: "myworkspace/C0AJY0FLK8Q/p1780098828635099",
		};

		expect(urlForRef(ref)).toBe(
			"https://myworkspace.slack.com/archives/C0AJY0FLK8Q/p1780098828635099",
		);
		expect(whyRefHasNoUrl(ref)).toBeUndefined();
	});

	it("explains a thread ref the same way, since they store alike", () => {
		const why =
			whyRefHasNoUrl({
				type: "slack-thread",
				value: "C0AJY0FLK8Q/1780098828635099",
			}) ?? "";

		expect(why).toContain("no workspace");
	});

	it("falls back to a general reason for anything else malformed", () => {
		const why =
			whyRefHasNoUrl({ type: "slack-message", value: "nonsense" }) ?? "";

		expect(why).toContain("nonsense");
		expect(why).toContain("workspace/CHANNEL/pTIMESTAMP");
	});
});

describe("refs that are not failing to encode", () => {
	it("says nothing for a type with no URL form at all", () => {
		// A person identity has no link, and that is not a gap. Reporting
		// one would put a complaint beside every such ref forever.
		registerRefType({
			type: "person",
			matchAll: () => [],
		});

		expect(whyRefHasNoUrl({ type: "person", value: "joel" })).toBeUndefined();
	});

	it("hands back a value that is already a link, whatever its type", () => {
		// Found by sweeping the live store: refs stored under types
		// nobody registered, holding a whole URL, rendering as no link.
		const ref = { type: "nobody-registered-this", value: "https://x.dev/a" };

		expect(urlForRef(ref)).toBe("https://x.dev/a");
		expect(whyRefHasNoUrl(ref)).toBeUndefined();
	});

	it("lets a registered type's own encoding win over the raw value", () => {
		registerRefType({
			type: "opinionated",
			matchAll: () => [],
			url: () => "https://canonical.example/1",
		});

		expect(
			urlForRef({ type: "opinionated", value: "https://raw.example/2" }),
		).toBe("https://canonical.example/1");
	});

	it("stays quiet about a non-URL under a type nobody registered", () => {
		// `depends-on: QEST-...` is a quest reference, not a broken link.
		// Complaining here would put a note beside every one of them.
		const ref = { type: "depends-on", value: "QEST-20260731-AAAAAA" };

		expect(urlForRef(ref)).toBeUndefined();
		expect(whyRefHasNoUrl(ref)).toBeUndefined();
	});

	it("names the type when one declines without explaining itself", () => {
		registerRefType({
			type: "terse",
			matchAll: () => [],
			url: () => undefined,
		});

		const why = whyRefHasNoUrl({ type: "terse", value: "x" }) ?? "";
		expect(why).toContain("terse");
		expect(why).toContain("x");
	});
});
