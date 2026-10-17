/**
 * Every write gate is drawn by one function, so the shape is learned once.
 *
 * The order is fixed and each part answers a question a person actually has:
 * where is this going, what is it answering, what exactly is being sent, and
 * what happens to the thread afterwards. Before this, reply and resolve
 * showed an anchor and nothing else, and publish showed op counts and thread
 * uuids: the gate that sent the most showed the least.
 *
 * The one rule worth a test of its own is what gives when the panel is
 * short. The payload is the thing the gate exists to show, so it is never
 * clipped. The quoted context is, one remark at a time rather than globally,
 * so a long opening remark cannot swallow the reply that matters.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	type GatePanel,
	gateLines,
	gateText,
} from "../../extensions/review-integration/render.ts";
import { fakeTheme } from "../lib/ui/fake-theme.ts";

const WIDTH = 72;

/** The rendered panel as one string, which is how a person reads it. */
function drawn(panel: GatePanel, width = WIDTH): string {
	return gateLines(panel, fakeTheme(), width).join("\n");
}

/** A body of `count` distinct, countable lines, each tagged with its origin. */
function longBody(count: number, tag = "line"): string {
	return Array.from({ length: count }, (_, at) => `${tag} ${at + 1}`).join(
		"\n",
	);
}

describe("drawing a write gate", () => {
	it("names the change and the provider, so two attached changes differ", () => {
		expect(drawn({ destination: "shop/world#2000980 · meteorite" })).toContain(
			"shop/world#2000980 · meteorite",
		);
	});

	it("wraps the header rows, which are the only ones that were not", () => {
		// A propose gate names a branch, a base and a repo key on one line, which
		// reaches 99 columns for an ordinary branch name. Every other row was
		// wrapped and these two were not, so the panel truncated them and the
		// repo, the one thing the checkout cannot tell you, fell off the end.
		const lines = gateLines(
			{
				destination:
					"jitsusama/judge-quoted-write-targets → main on github:Jitsusama/agentic-harness.pi",
				where:
					"a very long anchor that also has no business being truncated silently",
			},
			fakeTheme(),
			40,
		);

		// The fake theme marks colour with literal tags, which `visibleWidth`
		// counts because they are not escape codes. Strip them, or the test
		// measures the stand-in rather than the panel.
		for (const line of lines) {
			expect(
				visibleWidth(line.replace(/<\/?[a-z:]+>/g, "")),
			).toBeLessThanOrEqual(40);
		}
		// Wrapped, not dropped: the repo key still reaches the reader.
		expect(lines.join("\n")).toContain("agentic-harness.pi");
	});

	it("keeps the parts in order: destination, context, payload, consequence", () => {
		const text = drawn({
			destination: "shop/world#2000980 · meteorite",
			where: "policy.go:166 · open",
			context: [{ who: "binks", body: "the parser ignores unknown fields" }],
			payload: { as: "replying as joel.gerber", body: "Fixed in 0671cb0." },
			consequence: ["then resolves the thread"],
		});
		const at = (needle: string) => text.indexOf(needle);
		expect(at("shop/world#2000980")).toBeLessThan(at("policy.go:166"));
		expect(at("policy.go:166")).toBeLessThan(at("the parser ignores"));
		expect(at("the parser ignores")).toBeLessThan(at("Fixed in 0671cb0."));
		expect(at("Fixed in 0671cb0.")).toBeLessThan(at("then resolves"));
	});

	it("shows the payload whole, however long, since that is the point", () => {
		const text = drawn({
			destination: "shop/world#2000980",
			payload: { body: longBody(40) },
		});
		for (let at = 1; at <= 40; at++) expect(text).toContain(`line ${at}`);
	});

	it("clips a quoted remark, and says it clipped it", () => {
		const text = drawn({
			destination: "shop/world#2000980",
			context: [{ who: "binks", body: longBody(40) }],
		});
		expect(text).toContain("line 1");
		expect(text).not.toContain("line 40");
		expect(text).toContain("\u2026");
	});

	it("clips each remark rather than the exchange, so the last is still seen", () => {
		const text = drawn({
			destination: "shop/world#2000980",
			context: [
				{ who: "binks", body: longBody(40) },
				{ who: "evan.lee", body: "fixed in 0671cb0" },
			],
		});
		expect(text).toContain("evan.lee");
		expect(text).toContain("fixed in 0671cb0");
	});

	it("clips the context and not the payload when both are long", () => {
		const text = drawn({
			destination: "shop/world#2000980",
			context: [{ who: "binks", body: longBody(40, "quoted") }],
			payload: { body: longBody(40, "sending") },
		});
		expect(text).toContain("quoted 1");
		expect(text).not.toContain("quoted 40");
		for (let at = 1; at <= 40; at++) expect(text).toContain(`sending ${at}`);
	});

	it("attributes the payload when it is answering somebody", () => {
		expect(
			drawn({
				destination: "shop/world#2000980",
				payload: { as: "replying as joel.gerber", body: "Fixed." },
			}),
		).toContain("replying as joel.gerber");
	});

	it("says nothing about attribution for a bare remark", () => {
		expect(
			drawn({ destination: "shop/world#2000980", payload: { body: "Fixed." } }),
		).not.toContain("replying as");
	});

	it("draws a resolve panel: the exchange, and no payload at all", () => {
		const text = drawn({
			destination: "shop/world#2000980",
			where: "policy.go:166 · open",
			context: [
				{ who: "binks", body: "the parser ignores unknown fields" },
				{ who: "evan.lee", body: "fixed in 0671cb0" },
			],
		});
		expect(text).toContain("binks");
		expect(text).toContain("evan.lee");
		expect(text).not.toContain("\u21b3");
	});

	it("reads back as plain text, for the redirect to quote", () => {
		const panel: GatePanel = {
			destination: "shop/world#2000980 · meteorite",
			where: "policy.go:166 · open",
			context: [{ who: "binks", body: "the parser ignores unknown fields" }],
			payload: { as: "replying as joel.gerber", body: "Fixed in 0671cb0." },
			consequence: ["then resolves the thread"],
		};
		const text = gateText(panel, WIDTH);
		expect(text).toContain("shop/world#2000980");
		expect(text).toContain("the parser ignores unknown fields");
		expect(text).toContain("Fixed in 0671cb0.");
		expect(text).toContain("then resolves the thread");
	});

	it("says the same thing plain as it does styled", () => {
		// The redirect quotes the panel back, and the words it quotes have to
		// be the words that were approved against.
		//
		// This used to demand the two be identical byte for byte. It cannot
		// be, now that the body is drawn as markdown on screen: the point of
		// the quote is to be read as text by a model, so it carries the
		// source rather than the escape codes that rendered it. One layout
		// and one set of words is the invariant that was actually wanted;
		// identical presentation was how it happened to be enforced. The
		// screen also keeps the panel's one-column margin, which the quote
		// leaves out, so the comparison takes it off each styled row; both
		// lay out inside it, so the words still break in the same places.
		const panel: GatePanel = {
			destination: "shop/world#2000980",
			context: [{ who: "binks", body: "unknown fields" }],
			payload: { body: "Fixed." },
		};
		const plain = gateText(panel, WIDTH);
		const styled = gateLines(panel, fakeTheme(), WIDTH, (body) =>
			body.split("\n"),
		)
			.map((line) => (line.startsWith(" ") ? line.slice(1) : line))
			.join("\n")
			.replaceAll(/<\/?[\w:]+>/g, "");
		expect(plain).toBe(styled);
	});

	it("sets each speaker apart from what they said", () => {
		// A thread is several voices, and the eye goes down it by name: the
		// name in the text's colour, its words muted, and a wrapped remark's
		// later lines muted throughout.
		const panel: GatePanel = {
			destination: "shop/world#2000980",
			context: [
				{ who: "C1 binks", body: longBody(12) },
				{ who: "C2 joel", body: "agreed" },
			],
		};
		const rows = gateLines(panel, fakeTheme(), 60);
		const said = rows.filter((row) => row.includes("<text>"));
		expect(said).toEqual([
			expect.stringMatching(/^ <text> {3}C1 binks:<\/text><muted> /),
			` <text>   C2 joel:</text><muted> agreed</muted>`,
		]);
		expect(
			rows.filter((row) => row.includes("<muted>")).length,
		).toBeGreaterThan(3);
	});

	it("breaks its lines where the screen did when quoted plain", () => {
		// The screen lays out inside its margin, so the quote must too, or a
		// row that wraps on screen arrives at the model whole, and the
		// redirect quotes a panel nobody saw. A header of short words, at
		// every width across a range, puts a word boundary on the margin.
		const panel: GatePanel = {
			destination: "ab cd ef gh ij kl mn op qr st uv wx yz ".repeat(4).trim(),
			payload: { body: "Fixed." },
		};
		for (let width = 30; width <= 60; width++) {
			const styled = gateLines(panel, fakeTheme(), width, (body) =>
				body.split("\n"),
			)
				.map((line) => (line.startsWith(" ") ? line.slice(1) : line))
				.join("\n")
				.replaceAll(/<\/?[\w:]+>/g, "");
			expect(gateText(panel, width)).toBe(styled);
		}
	});

	it("wraps to the width it is given rather than overflowing the panel", () => {
		const lines = gateLines(
			{
				destination: "shop/world#2000980",
				payload: { body: "a ".repeat(80).trim() },
			},
			fakeTheme(),
			40,
		);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
	});
});
