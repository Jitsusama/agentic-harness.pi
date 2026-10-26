/**
 * The typography capture, checked against real line boxes.
 *
 * The unit tests judge blocks; these check the measuring,
 * because line breaks belong to the browser: a word walk that
 * grouped lines wrongly or a skipped exclusion would produce
 * plausible blocks that are about nothing.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyseTypography } from "../../../lib/core/web/design/typography.ts";
import { BrowserSession } from "../../../lib/core/web/session.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Text whose wrapping is arithmetic, not font luck.
 *
 * Monospace inside a 20ch container: every seven-character word
 * costs eight columns with its space, so two fit per line and
 * five columns remain, never the fourteen the final word needs.
 * The orphan is guaranteed on any machine with any monospace
 * font, where a proportional fixture wrapped differently
 * between fonts and put two words on the last line.
 */
const SEVENS = Array.from({ length: 10 }, () => "abcdefg").join(" ");
const PAGE = page(
	"Typography",
	`<main style="font-family:monospace;font-size:16px">
  <p id="orphaned" style="width:20ch">${SEVENS} unaccompanied</p>
  <p id="clean" style="width:20ch;text-wrap:balance">${SEVENS} unaccompanied</p>
  <details><summary>More</summary>
  <p id="collapsed" style="width:20ch">${SEVENS} unaccompanied</p></details>
  <p id="short">Too short to judge.</p>
</main>`,
);

let fixture: Fixture;
let session: BrowserSession;

describe.skipIf(!haveChrome)("typography capture, in a real browser", () => {
	beforeAll(async () => {
		fixture = await serve([{ path: "/type", body: PAGE }]);
		session = await BrowserSession.open("typography-contract");
		await session.navigate(fixture.url("/type"));
	});

	afterAll(async () => {
		await session?.close();
		await fixture?.close();
	});

	it("measures the wrapped paragraph and finds its orphan", async () => {
		const blocks = await session.typography();
		const orphaned = blocks.find((one) => one.selector === "#orphaned");

		expect(orphaned).toBeDefined();
		expect(orphaned?.lineCount).toBeGreaterThan(1);
		const findings = analyseTypography(blocks);
		expect(
			findings.some(
				(one) => one.block.selector === "#orphaned" && one.kind === "orphan",
			),
		).toBe(true);
	});

	it("reads the stranded word itself", async () => {
		const blocks = await session.typography();
		const orphaned = blocks.find((one) => one.selector === "#orphaned");

		expect(orphaned?.lastLine.words).toBe(1);
		expect(orphaned?.lastLine.text).toBe("unaccompanied");
	});

	it("leaves balanced text to the browser", async () => {
		const blocks = await session.typography();
		expect(blocks.some((one) => one.selector === "#clean")).toBe(false);
	});

	it("skips text inside a collapsed disclosure", async () => {
		const blocks = await session.typography();
		expect(blocks.some((one) => one.selector === "#collapsed")).toBe(false);
	});

	it("skips body text under the floor", async () => {
		const blocks = await session.typography();
		expect(blocks.some((one) => one.selector === "#short")).toBe(false);
	});
});
