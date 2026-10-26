/**
 * Whether one-off reads still share what sites tell them.
 *
 * Reads used to run in Chrome's default context, so a cookie a site
 * set during one read was sent on every later one. Each read now
 * gets a context of its own, and the jar is what carries cookies
 * between them. This is the property it has to keep, checked where
 * it matters: in the request the next read makes.
 */

import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeBrowser } from "../../../lib/core/web/browser.ts";
import { readPage } from "../../../lib/core/web/reader.ts";
import { type Fixture, haveChrome, page, serve } from "./_harness.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A page that writes the cookies it was sent into its own body. */
const ECHO = page(
	"Echo",
	'<main><p id="jar">none</p></main>' +
		"<script>document.getElementById('jar').textContent = " +
		"'sent:' + (document.cookie || 'nothing');</script>",
);

let fixture: Fixture;

describe.skipIf(!haveChrome)("reads share the cookies a site sets", () => {
	beforeAll(async () => {
		fixture = await serve([
			{
				path: "/set-session",
				body: page("Set", "<p>set</p>"),
				headers: { "set-cookie": "clearance=ok; Path=/" },
			},
			{
				path: "/set-lasting",
				body: page("Set", "<p>set</p>"),
				headers: { "set-cookie": "choice=kept; Path=/; Max-Age=3600" },
			},
			{
				path: "/clear",
				body: page("Clear", "<p>clear</p>"),
				headers: { "set-cookie": "clearance=; Path=/; Max-Age=0" },
			},
			{ path: "/echo", body: ECHO },
		]);
	});

	afterAll(async () => {
		await closeBrowser();
		await fixture?.close();
	});

	/** What the echo page was sent, as it wrote it into its body. */
	async function sent(): Promise<string> {
		const bundle = await readPage(fixture.url("/echo"));
		const text = bundle.innerTextPath
			? fs.readFileSync(bundle.innerTextPath, "utf8")
			: "";
		return text.match(/sent:(.*)/)?.[1]?.trim() ?? "";
	}

	it("sends a cookie one read was given on the next", async () => {
		await readPage(fixture.url("/set-session"));
		await readPage(fixture.url("/set-lasting"));

		const cookies = await sent();

		expect(cookies).toContain("clearance=ok");
		expect(cookies).toContain("choice=kept");
	});

	it("stops sending a cookie a later read was told to clear", async () => {
		await readPage(fixture.url("/set-session"));
		await readPage(fixture.url("/clear"));

		const cookies = await sent();

		expect(cookies).not.toContain("clearance");
		expect(cookies).toContain("choice=kept");
	});
});
