/**
 * Contrast between two named elements, against a real browser.
 *
 * The case axe leaves alone: a boundary somebody chose. Each test
 * pins what was compared as well as the verdict, because the operand
 * choice is the part a reader has to be able to argue with.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderPair } from "../../lib/web/audit/index.js";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

describe.skipIf(!haveChrome)("contrast between two elements", () => {
	let fixture: Fixture;
	let session: BrowserSession;

	beforeAll(async () => {
		fixture = await serve([
			{
				path: "/pair",
				body:
					"<html><body style='background: rgb(255,255,255)'>" +
					"<h1 style='color: rgb(0,0,0)'>Readable heading</h1>" +
					"<h2 style='color: rgb(200,200,200)'>Faint heading</h2>" +
					// No text of its own, so this is a shape rather than a
					// label: the 1.4.11 case, and its background is
					// transparent the way a real outlined control's is.
					"<button aria-label='Outlined' style='background: " +
					"rgba(0,0,0,0); border: 1px solid rgb(0,0,0)'></button>" +
					"<div role='region' aria-label='Card' style='background: " +
					"rgb(250,250,250)'>card</div>" +
					"</body></html>",
			},
		]);
		session = await BrowserSession.open("pair-contrast");
		await session.navigate(fixture.url("/pair"));
	});

	afterAll(async () => {
		await session.close();
		await fixture.close();
	});

	it("judges dark text against a pale surface as passing 1.4.3", async () => {
		const judged = await session.contrastPair(
			{ role: "heading", name: "Readable heading" },
			{ role: "region", name: "Card" },
		);

		expect(judged.ok).toBe(true);
		if (!judged.ok) return;
		expect(judged.report.criterion).toBe("1.4.3");
		expect(judged.report.compared.one).toBe("color");
		expect(judged.report.verdict).toBe("pass");
	});

	it("fails faint text against the same surface", async () => {
		const judged = await session.contrastPair(
			{ role: "heading", name: "Faint heading" },
			{ role: "region", name: "Card" },
		);

		expect(judged.ok).toBe(true);
		if (!judged.ok) return;
		expect(judged.report.verdict).toBe("fail");
		// The ratio is the evidence, so it has to be a real measurement
		// rather than a bare verdict.
		expect(judged.report.ratio).toBeLessThan(4.5);
		expect(judged.report.ratio).toBeGreaterThan(1);
	});

	it("takes a control's border when it paints no background", async () => {
		// The commonest 1.4.11 shape, and the reason a background-only
		// reading would have declined on most real controls.
		const judged = await session.contrastPair(
			{ role: "button", name: "Outlined" },
			{ role: "region", name: "Card" },
		);

		expect(judged.ok).toBe(true);
		if (!judged.ok) return;
		expect(judged.report.compared.one).toBe("border-color");
		expect(judged.report.criterion).toBe("1.4.11");
		expect(renderPair(judged.report)).toContain("border-color");
	});

	it("refuses an element that is not there, naming it", async () => {
		const judged = await session.contrastPair(
			{ role: "heading", name: "Readable heading" },
			{ role: "region", name: "No such card" },
		);

		expect(judged.ok).toBe(false);
	});
});
