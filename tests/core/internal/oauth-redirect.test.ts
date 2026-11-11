/**
 * The pages a login's browser tab is shown when its redirect lands.
 */

import { describe, expect, it } from "vitest";
import { redirectPages } from "../../../lib/core/internal/oauth-redirect.ts";

/** A blank a page left unfilled, which the person would read as it is. */
const UNFILLED = /%\w+%|page\.css/;

describe("the pages an OAuth redirect is answered with", () => {
	const pages = redirectPages("Slack");

	it("names the service the login was for and brings its styles", () => {
		expect(pages.success).toContain(
			"<h1>✓ Slack Authentication Successful</h1>",
		);
		expect(pages.success).toContain("prefers-color-scheme: dark");
		expect(pages.success).not.toMatch(UNFILLED);
	});

	it("shows the error a failed redirect carried, escaped", () => {
		const page = pages.failure('<img src=x onerror="alert(1)">');
		expect(page).toContain(
			"<p>Error: &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
		);
		expect(page).not.toMatch(UNFILLED);
	});

	it("says the error is unknown when the redirect carried none", () => {
		expect(pages.failure("")).toContain("<p>Error: Unknown error</p>");
	});

	it("escapes the service's name too", () => {
		expect(redirectPages("A & B").success).toContain(
			"A &amp; B Authentication",
		);
	});
});
