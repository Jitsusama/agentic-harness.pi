/**
 * The change a look's URL names, as the host is asked of it: a tab,
 * a file or a diff of a pull request is the pull request.
 */

import { describe, expect, it } from "vitest";
import { changePage } from "../../../extensions/review-integration/authored.ts";

const PR = "https://github.com/Jitsusama/agentic-harness.pi/pull/2188";

describe("the change a look's URL names", () => {
	it.each([
		PR,
		`${PR}/files`,
		`${PR}.diff`,
		`${PR}?w=1`,
		`${PR}#issuecomment-1`,
		`  ${PR}/commits/abc  `,
	])("reads %s as the pull request", (url) => {
		expect(changePage(url)).toBe(PR);
	});

	it("leaves a URL that names no pull request as it is", () => {
		expect(changePage("https://example.com/bar")).toBe(
			"https://example.com/bar",
		);
	});

	it("doesn't read a longer number as the change", () => {
		expect(changePage(`${PR}0`)).toBe(`${PR}0`);
	});
});
