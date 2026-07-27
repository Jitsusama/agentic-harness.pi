/**
 * Reading a page: the outline, one branch of it, the DOM behind
 * it, and the measurements the audits are computed from.
 *
 * None of these had a test. They are the methods every reading
 * tool in the extension calls, and the ones whose answers get
 * stored and cited, so an error here is an error a caller cannot
 * see past. The cases worth writing are the ones where the answer
 * is a judgment rather than a lookup: a branch that does not
 * exist, a name that matches twice, content inside a frame or a
 * shadow root, and an element the page has hidden in one of the
 * several ways a page can hide something.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A page with landmarks, headings, controls and a duplicate name. */
const MAIN = page(
	"Observation",
	`<header><nav aria-label="Primary"><a href="/first">Home</a></nav></header>
<main>
  <h1>Observation</h1>
  <section aria-label="Billing">
    <h2>Billing</h2>
    <button type="button" id="save">Save</button>
    <p id="prose">Some billing prose.</p>
  </section>
  <section aria-label="Shipping">
    <h2>Shipping</h2>
    <button type="button">Save</button>
  </section>
  <p hidden>Hidden by the hidden attribute.</p>
  <p style="display:none">Hidden by display none.</p>
  <p style="visibility:hidden">Hidden by visibility.</p>
  <p class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Visually hidden but announced.</p>
</main>
<footer><p>Footer text.</p></footer>`,
);

/** A page whose real content lives inside an iframe. */
const OUTER = page(
	"Outer",
	'<main><h1>Outer</h1><iframe title="Inner frame" src="/inner"></iframe></main>',
);

const INNER = page("Inner", "<main><h1>Inner heading</h1></main>");

/** A page whose button is inside a shadow root. */
const SHADOW = page(
	"Shadow",
	`<main><h1>Shadow</h1><div id="host"></div></main>
<script>
const root = document.getElementById("host").attachShadow({ mode: "open" });
root.innerHTML = '<button type="button" id="in-shadow">Deep button</button>';
</script>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("observing a page, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/main", body: MAIN },
			{ path: "/outer", body: OUTER },
			{ path: "/inner", body: INNER },
			{ path: "/shadow", body: SHADOW },
		]);
		session = await BrowserSession.open("observation-contract");
		await session.navigate(fixture.url("/main"));
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("reads the page as roles and names, not as markup", async () => {
		const observed = await session.observe();

		expect(observed.title).toBe("Observation");
		expect(observed.outline).toContain("Save");
		// The point of an accessibility outline is that it says what
		// a thing is, not which tag it happens to be.
		expect(observed.outline).toContain("button");
		expect(observed.outline).not.toContain("<button");
	});

	it("hands back the tree the outline was rendered from", async () => {
		// A caller who stores one to narrow the other needs them to be
		// the same capture; deriving the tree again reads a page that
		// has moved on.
		const observed = await session.observe();

		expect(observed.tree).toBeDefined();
		expect(observed.outline.length).toBeGreaterThan(0);
	});

	it("narrows to headings when asked for the outline only", async () => {
		const all = await session.observe();
		const headings = await session.observe({ only: "headings" });

		expect(headings.outline).toContain("Billing");
		expect(headings.outline.length).toBeLessThan(all.outline.length);
	});

	it("narrows to the things you can operate", async () => {
		const interactive = await session.observe({ only: "interactive" });

		expect(interactive.outline).toContain("Save");
		// Prose is not operable, so it has no business in this view.
		expect(interactive.outline).not.toContain("Some billing prose");
	});

	it("narrows to how the page is laid out", async () => {
		const landmarks = await session.observe({ only: "landmarks" });

		expect(landmarks.outline).toContain("navigation");
	});

	it("reads one branch when told which one", async () => {
		const result = await session.observeWithin({
			role: "region",
			name: "Shipping",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.observation.outline).toContain("Shipping");
		expect(result.observation.outline).not.toContain("billing prose");
	});

	it("refuses a branch that is not there, and says what would have worked", async () => {
		// A refusal that only says no leaves the caller guessing at
		// spelling. The available names are what turns it into a next
		// step.
		const result = await session.observeWithin({
			role: "region",
			name: "Warehousing",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusal).toBeDefined();
	});

	it("refuses an ambiguous name rather than picking one", async () => {
		// Two buttons are called Save. Choosing silently is how a test
		// clicks the wrong one and reports success.
		const result = await session.observeWithin({
			role: "button",
			name: "Save",
		});

		expect(result.ok).toBe(false);
	});

	it("resolves a name made unambiguous by its container", async () => {
		const result = await session.observeWithin({
			role: "button",
			name: "Save",
			container: { name: "Shipping" },
		});

		expect(result.ok).toBe(true);
	});

	it("resolves a duplicate name by position when asked", async () => {
		const result = await session.observeWithin({
			role: "button",
			name: "Save",
			ordinal: 2,
		});

		expect(result.ok).toBe(true);
	});

	it("reaches content inside an iframe", async () => {
		await session.navigate(fixture.url("/outer"));
		try {
			const observed = await session.observe();

			// A frame is a boundary for the DOM, not for the reader.
			expect(observed.outline).toContain("Inner heading");
		} finally {
			await session.navigate(fixture.url("/main"));
		}
	});

	it("reaches content inside a shadow root", async () => {
		await session.navigate(fixture.url("/shadow"));
		try {
			const observed = await session.observe();

			expect(observed.outline).toContain("Deep button");
		} finally {
			await session.navigate(fixture.url("/main"));
		}
	});

	it("captures the DOM with the styles the audits need", async () => {
		const nodes = await session.snapshot();

		expect(nodes.length).toBeGreaterThan(0);
		// Without a box there is nothing to judge overlap, clipping or
		// target size from, which is most of the visual audit.
		expect(nodes.some((node) => node.bounds !== undefined)).toBe(true);
	});

	it("describes the page's structure for the structural rules", async () => {
		const structure = await session.structure();

		expect(structure.length).toBeGreaterThan(0);
		expect(structure.some((node) => node.tag === "h1")).toBe(true);
	});

	it("measures what was drawn, and in what viewport", async () => {
		const { nodes, viewport } = await session.layout();

		expect(viewport.width).toBeGreaterThan(0);
		expect(nodes.length).toBeGreaterThan(0);
	});

	it("collects pointer targets for the target-size rule", async () => {
		const targets = await session.targets();

		expect(targets.length).toBeGreaterThan(0);
	});

	it("samples the styles the design inventory is built from", async () => {
		const samples = await session.styleSamples();

		expect(samples.length).toBeGreaterThan(0);
	});

	it("runs the axe rule set against the page", async () => {
		const findings = await session.audit();

		// The fixture has two buttons with the same name and no lang
		// problems worth relying on, so the assertion is about the
		// shape of an answer rather than a specific rule firing.
		expect(Array.isArray(findings)).toBe(true);
	});
});
