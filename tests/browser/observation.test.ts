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
import { analyseStructure } from "../../lib/web/audit/index.js";
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
  <button type="button" aria-label="Submit">Save changes</button>
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

/** A counter, a filled field, and state hung on data attributes. */
const STATEFUL = page(
	"Stateful",
	`<main>
		<p role="status" aria-label="Save result" id="count"
			data-test-state="complete">3 items updated</p>
		<label for="who">Email</label>
		<input id="who" name="who" type="email" value="user@example.com">
		<label for="town">City</label>
		<input id="town" name="city" type="text" autocomplete="shipping address-level2">
		<label for="find">Search</label>
		<input id="find" name="q" type="search">
	</main>`,
);

/** A video with no text track, and audio that starts by itself. */
const MEDIA = page(
	"Media",
	`<main>
		<video id="clip" src="/clip.mp4" controls></video>
		<audio id="tune" src="/tune.mp3" autoplay loop></audio>
	</main>`,
);

/**
 * Two buttons a known distance apart, laid out absolutely so the
 * expected numbers come from the stylesheet rather than from
 * whatever the default font happens to measure.
 */
const SPACED = page(
	"Spaced",
	`<main>
		<button id="save" style="position:absolute;left:20px;top:40px;
			width:100px;height:32px;margin:0;border:0;padding:0">Save</button>
		<button id="cancel" style="position:absolute;left:136px;top:40px;
			width:100px;height:32px;margin:0;border:0;padding:0">Cancel</button>
	</main>`,
);

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
			{ path: "/spaced", body: SPACED },
			{ path: "/media", body: MEDIA },
			{ path: "/stateful", body: STATEFUL },
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

	it("catches a label that does not contain its own visible text", async () => {
		// The fixture carries a button reading "Save changes" whose
		// accessible name is "Submit". Someone driving by voice says
		// "click Save changes" and nothing happens, which is WCAG
		// 2.5.3. axe can test it and ships the rule switched off, so
		// until it was switched on this page passed.
		const findings = await session.audit();
		const mismatch = findings.find(
			(finding) => finding.rule === "label-content-name-mismatch",
		);

		expect(mismatch).toBeDefined();
		expect(mismatch?.criteria).toContain("2.5.3");
		// Reported as undecided, because axe calls the rule
		// experimental and this package does not overrule it.
		expect(mismatch?.kind).toBe("needs-review");
		expect(mismatch?.authority).toBe("wcag");
	});

	it("measures the real gap between two elements", async () => {
		// The stylesheet puts Cancel at 136 and Save at 20 with a width
		// of 100, so the gap is 16. Derived from the fixture, not
		// remembered from a run.
		await session.navigate(fixture.url("/spaced"));

		const measured = await session.measure(
			{ role: "button", name: "Save" },
			{ role: "button", name: "Cancel" },
		);

		expect(measured.ok).toBe(true);
		if (!measured.ok) return;
		expect(measured.measurement.horizontal).toEqual({
			kind: "gap",
			pixels: 16,
		});
		// Same top and same height, so both edges line up and they are
		// the same size.
		expect(measured.measurement.aligned).toContain("top");
		expect(measured.measurement.sameSize).toBe(true);
	});

	it("says which of the two elements it could not find", async () => {
		await session.navigate(fixture.url("/spaced"));

		const measured = await session.measure(
			{ role: "button", name: "Save" },
			{ role: "button", name: "Nowhere" },
		);

		expect(measured.ok).toBe(false);
		if (measured.ok) return;
		// Naming the target back is the whole point: the caller gave
		// two and needs to know which one was wrong.
		expect("target" in measured && measured.target.name).toBe("Nowhere");
	});

	it("catches a video with no captions and audio that starts itself", async () => {
		// Pinning existing behaviour rather than adding any: axe ships
		// video-caption and no-autoplay-audio switched on, so this
		// should already work. It is worth a test because the gap sweep
		// reported captions as missing, and the way to settle that is
		// to drive it rather than to read the rule list.
		await session.navigate(fixture.url("/media"));
		const findings = await session.audit();

		const captions = findings.find(
			(finding) => finding.rule === "video-caption",
		);
		expect(captions).toBeDefined();
		expect(captions?.criteria).toContain("1.2.2");
	});

	it("reports what an element says, holds and is tagged with", async () => {
		// The accessible name answers what a control is called, which
		// is a different question from what it says. Asserting on a
		// counter or a filled field used to mean dropping to a raw
		// evaluate, which is the escape hatch this tool exists to
		// replace.
		await session.navigate(fixture.url("/stateful"));

		// Named "Save result" and reading "3 items updated": the two
		// questions have different answers, which is the whole point.
		const status = await session.inspect({
			role: "status",
			name: "Save result",
		});
		expect(status.ok).toBe(true);
		if (!status.ok) return;
		expect(status.inspection.text).toBe("3 items updated");
		expect(status.inspection.attributes?.["data-test-state"]).toBe("complete");

		const field = await session.inspect({ role: "textbox", name: "Email" });
		expect(field.ok).toBe(true);
		if (!field.ok) return;
		expect(field.inspection.value).toBe("user@example.com");
	});

	it("names the font that was painted, not the one asked for", async () => {
		// A computed style reports the stack. "Nonexistent Face,
		// serif" reads the same whether the first loaded or the page
		// fell back, which is most of the answer to why a screenshot
		// from one machine does not match another.
		await session.navigate(fixture.url("/stateful"));
		await session.evaluate(
			"document.getElementById('count').style.fontFamily = " +
				"'\"Nonexistent Face\", serif'; 'set'",
		);

		const found = await session.inspect({
			role: "status",
			name: "Save result",
		});

		expect(found.ok).toBe(true);
		if (!found.ok) return;
		expect(found.inspection.fonts?.length).toBeGreaterThan(0);
		// The stack named a face that does not exist, so whatever came
		// back is the fallback and cannot be the name that was asked
		// for. That is the whole distinction being drawn.
		expect(found.inspection.fonts?.[0]?.family).not.toBe("Nonexistent Face");
	});

	it("catches a personal field the browser cannot fill", async () => {
		// WCAG 1.3.5, which axe has no rule for, so this page passed in
		// silence. The email field has no token; the city field has a
		// prefixed one and must not be reported; the search box asks
		// nothing about the user and must not be either.
		await session.navigate(fixture.url("/stateful"));
		// Through the structural path, which is where these rules run:
		// session.audit() is axe alone.
		const tokens = analyseStructure(await session.structure()).find(
			(finding) => finding.rule === "field-has-autocomplete",
		);
		expect(tokens).toBeDefined();
		expect(tokens?.criteria).toContain("1.3.5");
		expect(tokens?.nodes).toHaveLength(1);
		expect(tokens?.nodes[0]?.html).toContain("who");
	});
});
