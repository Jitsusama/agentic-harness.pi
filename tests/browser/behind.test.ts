import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, serve } from "./_harness.js";

// Text over a gradient is the case axe hands back as needing a
// person, and the only way to know the subtraction works is to run it
// against a real one. Each fixture puts white text somewhere the
// answer is known by construction.

/**
 * White text over black-to-white, with the gradient reaching white a
 * fifth of the way across so the glyphs themselves run out over it.
 * A gentler ramp passes honestly, because the text stops before the
 * light end and the mask only judges where the text goes.
 */
const GRADIENT = `<!doctype html><html><body style="margin:0">
<h1 id="over" style="margin:0;width:400px;height:60px;
font:700 20px/60px sans-serif;color:#ffffff;
background:linear-gradient(to right,#000000 0%,#ffffff 20%)">Gradient heading</h1>
</body></html>`;

/** White text over black only. Nothing here is close to failing. */
const SAFE = `<!doctype html><html><body style="margin:0">
<h1 id="over" style="margin:0;width:400px;height:60px;
font:700 20px/60px sans-serif;color:#ffffff;background:#000000">
Solid heading</h1></body></html>`;

/**
 * Text that was already invisible before anything was hidden. The
 * accessibility tree still names it, so it can be asked about, and
 * hiding text that paints nothing changes nothing.
 */
const EMPTY = `<!doctype html><html><body style="margin:0">
<h1 id="over" style="margin:0;width:400px;height:60px;
font:700 20px/60px sans-serif;color:transparent;
background:linear-gradient(to right,#000000,#ffffff)">Ghost heading</h1>
</body></html>`;

let fixture: Fixture | undefined;
let session: BrowserSession;

describe.skipIf(!haveChrome)("contrast behind text, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/gradient", body: GRADIENT },
			{ path: "/safe", body: SAFE },
			{ path: "/empty", body: EMPTY },
		]);
		session = await BrowserSession.open("behind-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("fails white text where the gradient runs light", async () => {
		await session.navigate(fixture?.url("/gradient") ?? "");

		const result = await session.contrastBehind({
			role: "heading",
			name: "Gradient heading",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// White on white is 1:1, and the gradient reaches white, so the
		// worst place the glyphs sit has to be near the floor.
		expect(result.report.verdict).toBe("fail");
		expect(result.report.worstRatio).toBeLessThan(2);
		expect(result.report.glyphPixels).toBeGreaterThan(100);
	});

	it("passes the same text over a background that stays dark", async () => {
		// The control. Without it, a subtraction that always failed
		// would look like it was working on the fixture above.
		await session.navigate(fixture?.url("/safe") ?? "");

		const result = await session.contrastBehind({
			role: "heading",
			name: "Solid heading",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.verdict).toBe("pass");
		expect(result.report.worstRatio).toBeGreaterThan(20);
	});

	it("measures the glyphs rather than the box they sit in", async () => {
		// The whole point of the mask. This box spans black through
		// white, so judging every pixel in it would report 1:1 for any
		// content whatsoever. The count has to be a small share of the
		// box's own area.
		await session.navigate(fixture?.url("/gradient") ?? "");

		const result = await session.contrastBehind({
			role: "heading",
			name: "Gradient heading",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.glyphPixels).toBeLessThan(400 * 60 * 0.5);
	});

	it("declines to judge an element whose text left no mark", async () => {
		await session.navigate(fixture?.url("/empty") ?? "");

		const result = await session.contrastBehind({
			role: "heading",
			name: "Ghost heading",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.verdict).toBe("undecidable");
	});

	it("puts the text back after measuring it", async () => {
		// The restore is the part a reader cannot see going wrong. If
		// it leaks, everything captured later in the session is of a
		// page with invisible headings, and the failure surfaces
		// somewhere else entirely.
		await session.navigate(fixture?.url("/safe") ?? "");
		await session.contrastBehind({
			role: "heading",
			name: "Solid heading",
		});

		const after = await session.evaluate(
			`getComputedStyle(document.getElementById("over")).color`,
		);

		expect(JSON.stringify(after)).toContain("255, 255, 255");
	});

	it("refuses a target it cannot find instead of guessing", async () => {
		await session.navigate(fixture?.url("/safe") ?? "");

		const result = await session.contrastBehind({
			role: "heading",
			name: "Nothing by this name",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusal.reason).toBe("notFound");
	});
});
