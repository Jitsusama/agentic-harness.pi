import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pageScript } from "../../../lib/core/web/page-script.ts";

/** A `.page.js` file holding the given text, as the URL a module names it by. */
function fileOf(text: string): URL {
	const dir = mkdtempSync(join(tmpdir(), "page-script-"));
	const path = join(dir, "probe.page.js");
	writeFileSync(path, text);
	return pathToFileURL(path);
}

describe("a page script", () => {
	it("drops the formatter's closing semicolon, so it can be wrapped as an expression", () => {
		const url = fileOf(
			"// Asks the page its title.\n(() => document.title)();\n",
		);
		expect(pageScript(url)).toBe(
			"// Asks the page its title.\n(() => document.title)()",
		);
	});

	it("keeps a semicolon that doesn't close the file", () => {
		const url = fileOf("const a = 1;\nconst b = a + 1\n");
		expect(pageScript(url)).toBe("const a = 1;\nconst b = a + 1");
	});

	it("drops only one closing semicolon", () => {
		expect(pageScript(fileOf("f();;\n"))).toBe("f();");
	});
});
