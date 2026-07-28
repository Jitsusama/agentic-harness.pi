import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

/**
 * Four deliberately different hover treatments.
 *
 * .both changes on hover and on focus. .hoveronly offers the
 * keyboard nothing. .beaten has a hover rule a more specific rule
 * overrides, so the stylesheet says it hovers and the computed
 * style says it does not. .plain has no hover rule at all.
 */
const HOVERS = page(
	"Hovers",
	`<style>
  a.both:hover { background-color: #eeeeff }
  a.both:focus { background-color: #eeeeff }
  button.hoveronly:hover { background-color: #333333 }
  .beaten:hover { color: #ff0000 }
  .beaten { color: #000000 !important }
  .plain { color: #222222 }
  a.many:hover { background-color: #f5f5f5 }
  /* Last in the sheet, so it is the last candidate measured, and it
     has a focus rule so a state left forced on it is visible. */
  a.last:hover { background-color: #00ff00 }
  a.last:focus { background-color: #00ff00 }
</style>
<main>
  <a class="both" href="#a">both</a>
  <button class="hoveronly">hover only</button>
  <a class="beaten" href="#b">beaten</a>
  <span class="plain">plain</span>
  <a class="many" href="#m1">m1</a>
  <a class="many" href="#m2">m2</a>
  <a class="many" href="#m3">m3</a>
  <a class="last" href="#z">last</a>
</main>`,
);

const FLAT = page("Flat", "<main><p>No hover anywhere.</p></main>");

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("what the page does on hover, for real", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/hovers", body: HOVERS },
			{ path: "/flat", body: FLAT },
		]);
		session = await BrowserSession.open("hover-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("finds the elements a stylesheet says might hover", async () => {
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers();

		// Five selectors carry a hover, and .many matches three
		// elements, so seven candidates in all.
		expect(report.candidates).toBe(7);
	});

	it("reports the hover a keyboard user never gets", async () => {
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers();
		const named = report.pointerOnly.flatMap((group) => group.elements);

		expect(named).toContain("button.hoveronly");
	});

	it("does not accuse a hover that focus matches", async () => {
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers();
		const named = report.pointerOnly.flatMap((group) => group.elements);

		expect(named).not.toContain("a.both");
	});

	it("catches a declared hover the cascade beat", async () => {
		// The point of reading the computed style rather than trusting
		// the stylesheet. A scan alone would report this as a hover
		// treatment; holding the state proves it changes nothing.
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers();

		expect(report.inert).toContain("a.beaten");
	});

	it("groups the elements that share one treatment", async () => {
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers();
		const shared = report.groups.find((group) => group.elements.length === 3);

		expect(shared).toBeDefined();
	});

	it("releases the forced state, so a later reading is untouched", async () => {
		await session.navigate(fixture.url("/hovers"));
		await session.hovers();

		// Measured, after two earlier versions of this test proved
		// nothing. Every candidate but the last is released incidentally,
		// because the next candidate's DOM.getDocument invalidates its
		// node id and drops the forced state with it. So only the last
		// element measured can be caught still holding one, and only if
		// it has a focus rule, since reading focus replaces the forced
		// hover rather than adding to it. a.last is last in the
		// stylesheet and has both rules for exactly that reason: with the
		// release removed its background stays green here.
		const stuck = await session.evaluate(
			"getComputedStyle(document.querySelector('a.last')).backgroundColor",
		);

		expect(JSON.stringify(stuck)).toContain("rgba(0, 0, 0, 0)");
	});

	it("honours a limit, since each candidate costs a round trip", async () => {
		await session.navigate(fixture.url("/hovers"));

		const report = await session.hovers(2);

		expect(report.candidates).toBe(2);
	});

	it("says a page with no hover rule has none", async () => {
		await session.navigate(fixture.url("/flat"));

		const report = await session.hovers();

		expect(report.candidates).toBe(0);
		expect(report.unreadableSheets).toBe(0);
	});
});
