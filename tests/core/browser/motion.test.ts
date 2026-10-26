/**
 * The reduced-motion capture, checked against a real browser.
 *
 * The unit tests judge captures; these check the capture itself,
 * because the faults it can have are browser faults: an emulation
 * that never reached the page, an animation getAnimations does
 * not report, a preference that leaked into the session after the
 * audit finished.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyseMotion } from "../../../lib/core/web/audit/motion.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A page that respects the preference: motion gated behind it. */
const HONOURS = page(
	"Honours",
	'<main><h1>Honours</h1><div class="spinner">on</div></main>',
	`<style>
@media (prefers-reduced-motion: no-preference) {
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { animation: spin 1s linear infinite; }
}
</style>`,
);

/** A page that animates endlessly no matter what was asked. */
const IGNORES = page(
	"Ignores",
	'<main><h1>Ignores</h1><div class="marquee">forever</div></main>',
	`<style>
@keyframes drift { to { transform: translateX(40px); } }
.marquee { animation: drift 1s linear infinite; }
</style>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("motion under reduce, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([
			{ path: "/honours", body: HONOURS },
			{ path: "/ignores", body: IGNORES },
		]);
		session = await BrowserSession.open("motion-contract");
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("sees the preference and a page that honours it holds still", async () => {
		await session.navigate(fixture.url("/honours"));
		const capture = await session.motionUnderReduce();

		expect(capture.reduced).toBe(true);
		expect(analyseMotion(capture)).toEqual([]);
	});

	it("catches a page that animates through the preference", async () => {
		await session.navigate(fixture.url("/ignores"));
		const capture = await session.motionUnderReduce();

		expect(capture.reduced).toBe(true);
		const findings = analyseMotion(capture);
		expect(findings.map((one) => one.rule)).toContain(
			"animation-runs-under-reduced-motion",
		);
		expect(findings[0]?.nodes[0]?.selector).toBe("div.marquee");
	});

	it("puts the emulation back the way it was", async () => {
		await session.navigate(fixture.url("/ignores"));
		await session.motionUnderReduce();

		// The audit borrowed the preference; the session must not
		// keep it, or every later reading happens under reduce.
		expect(session.emulated.reducedMotion).toBeUndefined();
	});

	it("keeps an emulation the caller had already asked for", async () => {
		await session.emulate({ colorScheme: "dark" });
		await session.navigate(fixture.url("/honours"));
		await session.motionUnderReduce();

		expect(session.emulated.colorScheme).toBe("dark");
		expect(session.emulated.reducedMotion).toBeUndefined();
		await session.emulate({}, ["colorScheme"]);
	});
});
