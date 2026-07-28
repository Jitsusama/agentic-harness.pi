import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

/** Several promotions, one of them far larger than the rest. */
const LAYERED = page(
	"Layered",
	`<style>
  .hint { will-change: transform; width: 200px; height: 120px; background: #eee }
  .fixed { position: fixed; top: 0; right: 0; width: 80px; height: 40px; background: #ccc }
  .huge { will-change: transform; width: 1400px; height: 1600px; background: #f0f0f0 }
  .plain { width: 100px; height: 30px; background: #bbb }
</style>
<main>
  <div class="hint" id="hinted">will-change</div>
  <div class="fixed">fixed</div>
  <div class="huge">huge</div>
  <div class="plain">plain</div>
</main>`,
);

/** Nothing here asks the compositor for anything. */
const FLAT = page("Flat", "<main><p>Just text.</p></main>");

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)(
	"reading the layer tree, in a real browser",
	() => {
		beforeAll(async () => {
			fixture = await serve([
				{ path: "/layered", body: LAYERED },
				{ path: "/flat", body: FLAT },
			]);
			session = await BrowserSession.open("layers-contract");
		});

		afterAll(async () => {
			await session?.close();
			await fixture?.close();
		});

		it("reports the tree of a page that has already settled", async () => {
			// The whole difficulty of this surface: LayerTree pushes nothing
			// when enabled, so a page that finished loading long ago has no
			// change left to report. If the elicitation ever stops working
			// this comes back empty.
			await session.navigate(fixture.url("/layered"));

			const report = await session.layers();

			expect(report.layers.length).toBeGreaterThan(1);
			expect(report.memoryBytes).toBeGreaterThan(0);
		});

		it("names the element behind a promoted layer", async () => {
			await session.navigate(fixture.url("/layered"));

			const report = await session.layers();
			const named = report.layers
				.map((layer) => layer.element)
				.filter((name): name is string => name !== undefined);

			expect(named).toContain("div#hinted");
		});

		it("attributes the will-change hint to the layers that carry it", async () => {
			await session.navigate(fixture.url("/layered"));

			const report = await session.layers();
			const hint = report.byReason.find((entry) =>
				entry.reason.includes("will-change: transform"),
			);

			expect(hint).toBeDefined();
			expect(hint?.count).toBeGreaterThanOrEqual(2);
		});

		it("orders the promoted elements by the texture they hold", async () => {
			await session.navigate(fixture.url("/layered"));

			const report = await session.layers();
			const order = report.layers.map((layer) => layer.element);

			// Measured: the heaviest layer on this page is the document's own
			// scrolling contents at 1408 by 2060, which outweighs the 1400 by
			// 1600 promotion. That is a true answer rather than a fault, so
			// what is asserted is the ordering among the elements that were
			// deliberately promoted.
			// Named by id, since that is what a reader would search for and
			// what nameNode prefers when an element carries one.
			expect(order).toContain("div#hinted");
			expect(order).toContain("div.fixed");
			expect(order.indexOf("div.huge")).toBeLessThan(
				order.indexOf("div#hinted"),
			);
			expect(order.indexOf("div.huge")).toBeLessThan(
				order.indexOf("div.fixed"),
			);
		});

		it("bills no memory for a layer that draws nothing", async () => {
			await session.navigate(fixture.url("/layered"));

			const report = await session.layers();

			for (const layer of report.layers) {
				if (!layer.drawsContent) expect(layer.memoryBytes).toBe(0);
			}
		});

		it("answers the same way when asked twice in a row", async () => {
			await session.navigate(fixture.url("/layered"));
			const first = await session.layers();

			const again = await session.layers();

			expect(again.layers.length).toBe(first.layers.length);
			// Note what this does not prove. The read disables the domain
			// afterwards so it leaves no instrumentation running, but that is
			// invisible from out here: the screenshot elicits a fresh tree
			// whether or not the domain was already on, so this test passes
			// either way. It was written claiming to guard the disable, and a
			// mutation removing the disable did not fail it. What it really
			// checks is that reading twice is stable.
		});

		it("says a flat page composited nothing much rather than failing", async () => {
			await session.navigate(fixture.url("/flat"));

			const report = await session.layers();

			// Chrome always keeps structural layers, and it attributes some
			// of them to the document node itself, so "no element layers" is
			// not the honest claim. What holds is that nothing the author
			// wrote asked for a layer of its own.
			const authored = report.layers
				.map((layer) => layer.element)
				.filter((name): name is string => name !== undefined)
				.filter((name) => !name.startsWith("#"));

			expect(authored).toEqual([]);
		});
	},
);
