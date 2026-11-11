import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { pageCall, pageScript } from "../../../lib/core/web/page-script.ts";

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

describe("a page script called with what it takes", () => {
	/** What the page would get back from evaluating a call. */
	const run = (call: string): unknown => new Function(`return ${call};`)();

	it("takes its helpers first and its values last, as one object", () => {
		const url = fileOf("(add, { n }) => add(n, 1);\n");
		const call = pageCall(url, {
			helpers: ["(a, b) => a + b"],
			values: { n: 2 },
		});
		expect(run(call)).toBe(3);
	});

	it("takes only its helpers when it names no values", () => {
		const url = fileOf("(helpers) => Object.keys(helpers);\n");
		expect(run(pageCall(url, { helpers: ["({ shown: 1 })"] }))).toEqual([
			"shown",
		]);
	});

	it("takes a value as JSON, so a string arrives whole", () => {
		const url = fileOf("({ selector }) => selector;\n");
		const selector = '[role="dialog"][aria-modal="true"]';
		expect(run(pageCall(url, { values: { selector } }))).toBe(selector);
	});
});
