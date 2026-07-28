/**
 * Reading what holds focus, against a real browser.
 *
 * The interesting cases are the two that sent people looking at the
 * wrong element: focus parked on the body, which is not a control,
 * and focus inside a shadow root, which reads as the host from
 * outside.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderFocus } from "../../lib/web/a11y/index.js";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

describe.skipIf(!haveChrome)("what holds focus", () => {
	let fixture: Fixture;
	let session: BrowserSession;

	beforeAll(async () => {
		fixture = await serve([
			{
				path: "/focus",
				body:
					"<html><body>" +
					'<button id="save">Save changes</button>' +
					'<input aria-label="Search the docs">' +
					'<div id="host"></div>' +
					"<script>" +
					"const root = document.getElementById('host')" +
					".attachShadow({ mode: 'open' });" +
					"root.innerHTML = '<button id=inner>Inner action</button>';" +
					"</script>" +
					"</body></html>",
			},
		]);
		session = await BrowserSession.open("focus-read");
		await session.navigate(fixture.url("/focus"));
	});

	afterAll(async () => {
		await session.close();
		await fixture.close();
	});

	it("says nothing holds focus on a page nobody has touched", async () => {
		const said = renderFocus(await session.focusHolder());

		expect(said).toMatch(/nothing holds focus/i);
	});

	it("names the control a tab press lands on", async () => {
		await session.press("Tab");

		const said = renderFocus(await session.focusHolder());

		expect(said).toContain('button "Save changes"');
		expect(said).not.toMatch(/nothing holds/i);
	});

	it("reads an accessible name that came from an aria-label", async () => {
		await session.press("Tab");

		expect(renderFocus(await session.focusHolder())).toContain(
			'"Search the docs"',
		);
	});

	it("follows focus down into a shadow root", async () => {
		// Without following the chain this reports the host div, which
		// is the element a reader would then go and inspect in vain.
		await session.act({
			kind: "focus",
			target: { role: "button", name: "Inner action" },
		});

		const said = renderFocus(await session.focusHolder());

		expect(said).toContain("Inner action");
		expect(said).toMatch(/shadow/i);
	});
});
