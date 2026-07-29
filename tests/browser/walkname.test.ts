import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

/**
 * Three fields, named three ways: a label pointing at its control, a
 * label wrapping one, and a control named through aria-labelledby.
 * None of them carries the name anywhere the walk used to look.
 */
const FORM = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Form</title></head><body>
<form>
  <label for="email">Email address</label>
  <input id="email" type="email">

  <label>Postal code <input id="postal" type="text"></label>

  <span id="cc">Card number</span>
  <input id="card" type="text" aria-labelledby="cc">

  <input id="anon" type="text">
</form>
</body></html>`;

describe.skipIf(!haveChrome)("what a keyboard walk calls each stop", () => {
	let fixture: Fixture;
	let session: BrowserSession;

	beforeAll(async () => {
		fixture = await serve([{ path: "/", body: FORM, type: "text/html" }]);
		session = await BrowserSession.open("walkname");
		await session.navigate(fixture.url("/"));
	});

	afterAll(async () => {
		await session.close();
		await fixture.close();
	});

	it("names a field by its label however the label is attached", async () => {
		const capture = await session.keyboardWalk();
		const named = capture.stops.map((stop) => stop.name);

		expect(named).toContain("Email address");
		expect(named).toContain("Postal code");
		expect(named).toContain("Card number");
	});

	it("leaves a genuinely unnamed field unnamed", async () => {
		// The control. Inventing a name for a field that has none
		// would hide the very fault an audit is looking for, so the
		// anonymous input must still come back empty.
		const capture = await session.keyboardWalk();
		const anon = capture.stops.find((stop) => stop.id === "anon");

		expect(anon).toBeDefined();
		expect(anon?.name).toBe("");
	});
});
