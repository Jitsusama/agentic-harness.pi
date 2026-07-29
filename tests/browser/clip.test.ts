import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

/**
 * Taller than the viewport, deliberately. Every capture fixture in
 * the suite before this one fitted on one screen, so no test could
 * scroll, so no test could disagree with a clip measured in the
 * wrong coordinate space.
 *
 * The marker is one flat colour, carries no text, and is named
 * through aria-label so it can be asked for by role and name. A
 * picture of it is then all one known colour, and a picture of
 * anywhere else on this page is not.
 */
const TALL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Tall</title></head><body style="margin:0;background:#ffffff">
  <div style="height:80px;background:#123456"></div>
  <div style="height:1400px">a long middle</div>
  <div id="mark" role="img" aria-label="Marker"
    style="width:120px;height:60px;background:#00b894"></div>
  <p id="words" style="margin:0;font:16px/40px sans-serif;color:#bbbbbb"
    >Faint body text far down the page</p>
  <div style="height:600px">a long tail</div>
</body></html>`;

/** The marker's colour, exactly as the page declares it. */
const MARKER = "0,184,148";

describe.skipIf(!haveChrome)("clipping a capture to one element", () => {
	let fixture: Fixture;
	let session: BrowserSession;

	beforeAll(async () => {
		fixture = await serve([{ path: "/", body: TALL, type: "text/html" }]);
		session = await BrowserSession.open("clip");
	});

	afterAll(async () => {
		await session.close();
		await fixture.close();
	});

	/** Every distinct colour in a written image, as "r,g,b". */
	const coloursIn = (path: string): string[] => {
		const png = PNG.sync.read(readFileSync(path));
		const seen = new Set<string>();
		for (let at = 0; at < png.data.length; at += 4) {
			seen.add(`${png.data[at]},${png.data[at + 1]},${png.data[at + 2]}`);
		}
		return [...seen];
	};

	it("photographs the element, not whatever sits at its coordinates", async () => {
		await session.navigate(fixture.url("/"));
		// Scrolled, which is where the two coordinate spaces part. On a
		// live page this returned a blank crop of the spacer instead of
		// the marker, and nothing about the image said so.
		await session.evaluate(
			"document.getElementById('mark').scrollIntoView({block:'center'})",
		);

		const taken = await session.shoot({
			target: { role: "image", name: "Marker" },
		});

		expect(taken.ok).toBe(true);
		if (!taken.ok) return;
		const [path] = taken.shot.paths;
		expect(path).toBeDefined();
		// The marker is flat and textless, so its picture holds exactly
		// one colour. Anything else means the clip landed elsewhere:
		// white for the gaps, or the dark band at the top of the page.
		expect(coloursIn(path ?? "")).toEqual([MARKER]);
	});

	it("photographs an element below the fold without scrolling to it", async () => {
		// The control for the test above: at scroll zero the two spaces
		// coincide, so this passed before the fix and has to keep
		// passing after it.
		await session.navigate(fixture.url("/"));

		const taken = await session.shoot({
			target: { role: "image", name: "Marker" },
		});

		expect(taken.ok).toBe(true);
		if (!taken.ok) return;
		expect(coloursIn(taken.shot.paths[0] ?? "")).toEqual([MARKER]);
	});

	it("measures contrast of text far down the page", async () => {
		await session.navigate(fixture.url("/"));

		const judged = await session.contrastBehind({
			role: "StaticText",
			name: "Faint body text far down the page",
		});

		expect(judged.ok).toBe(true);
		if (!judged.ok) return;
		expect(judged.report.undecided).toBeUndefined();
		expect(judged.report.glyphPixels).toBeGreaterThan(100);
	});

	it("measures the same text once the page has been scrolled", async () => {
		// The other half of the fault: an element well inside the
		// viewport still fails, because the clip is out by however far
		// the page has moved.
		await session.navigate(fixture.url("/"));
		await session.evaluate(
			"document.getElementById('words').scrollIntoView({block:'center'})",
		);

		const judged = await session.contrastBehind({
			role: "StaticText",
			name: "Faint body text far down the page",
		});

		expect(judged.ok).toBe(true);
		if (!judged.ok) return;
		expect(judged.report.undecided).toBeUndefined();
		expect(judged.report.glyphPixels).toBeGreaterThan(100);
	});
});
