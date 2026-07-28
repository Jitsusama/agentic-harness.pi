import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../../lib/web/session.js";
import { type Fixture, haveChrome, page, serve } from "./_harness.js";

/**
 * Text at 4.54 to 1 against white.
 *
 * That grey is the classic AA-passing value: it clears 1.4.3's 4.5
 * and falls well short of 1.4.6's 7. So it is exactly the page that
 * must come back clean at AA and dirty at AAA, and if the bar were
 * not reaching the enhanced rules it would look clean at both.
 */
const NEARLY = page(
	"Nearly",
	`<style>
  body { background: #ffffff }
  p { color: #767676; font-size: 16px }
</style>
<main><h1>Nearly</h1><p>This text is grey enough for AA and no more.</p></main>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)(
	"holding a page to a bar, in a real browser",
	() => {
		beforeAll(async () => {
			fixture = await serve([{ path: "/nearly", body: NEARLY }]);
			session = await BrowserSession.open("conformance-contract");
			await session.navigate(fixture.url("/nearly"));
		});

		afterAll(async () => {
			await session?.close();
			await fixture?.close();
		});

		it("says nothing about enhanced contrast when held to AA", async () => {
			const findings = await session.audit("AA");

			expect(findings.map((finding) => finding.rule)).not.toContain(
				"color-contrast-enhanced",
			);
		});

		it("finds the enhanced contrast failure when held to AAA", async () => {
			// The control for the test above. Without this, an audit that
			// silently ran no AAA rule at all would pass the AA assertion
			// and the whole bar would be decorative.
			const findings = await session.audit("AAA");

			const enhanced = findings.filter(
				(finding) => finding.rule === "color-contrast-enhanced",
			);
			expect(enhanced).toHaveLength(1);
			expect(enhanced[0].criteria).toContain("1.4.6");
			expect(enhanced[0].levels).toContain("AAA");
		});

		it("reaches for the enhanced bar without being asked", async () => {
			const findings = await session.audit();

			expect(findings.map((finding) => finding.rule)).toContain(
				"color-contrast-enhanced",
			);
		});

		it("still passes the ordinary contrast rule at every bar", async () => {
			// The page really does meet AA. If this ever fails, the fixture
			// colour has drifted and the two tests above stop meaning what
			// they claim to mean.
			for (const bar of ["AA", "AAA"] as const) {
				const findings = await session.audit(bar);

				expect(findings.map((finding) => finding.rule)).not.toContain(
					"color-contrast",
				);
			}
		});
	},
);
