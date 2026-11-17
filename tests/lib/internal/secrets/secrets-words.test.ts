/**
 * The words of a printing of the environment, each judged on its own: a
 * value reads as no variable's name for the equals its padding ends in,
 * nor is exempted by a path or an address any joiner puts before it, nor
 * by words shaped as a mark around it; a terminal's link is read as an
 * escape; a coloured path reads as a path; and no mark lands where a
 * terminal would read it as an escape.
 *
 * Each credential is made from pieces as the test runs.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scrubToolResult } from "../../../../lib/internal/secrets/secrets.ts";

const fresh = () => `z9${randomBytes(19).toString("hex")}`;
const VALUE_MARK = "[secret scrubbed: environment value]";

/** The text a dump's answer shows once scrubbed, printed by `command`. */
function shown(printed: string, command = "printenv"): string | undefined {
	const answer = { content: [{ type: "text", text: printed }] };
	const scrubbed = scrubToolResult(answer, { command });
	const [part] = scrubbed?.content ?? answer.content;
	return part?.type === "text" ? part.text : undefined;
}

describe("a bare value in a printing of the environment", () => {
	const python = "python3 -c 'import os;print(os.environ)'";

	it("is put out of sight when one equals of padding ends it before a quote, a comma or an escape", () => {
		for (const after of ["'", '"', ",", "\x1b[0m", "]"]) {
			const value = `${fresh()}Q`;
			const text = shown(`environ({'A': '1', 'B': ${value}=${after}})\n`, python);
			expect(text, JSON.stringify(after)).toBeDefined();
			expect(text, JSON.stringify(after)).not.toContain(value);
		}
	});

	it("is put out of sight when an equals follows it only on the next line", () => {
		const value = fresh();
		const text = shown(`${value}\n=x\n`, "launchctl getenv PROXY_CRED");
		expect(text).toBeDefined();
		expect(text).not.toContain(value);
	});

	it("is put out of sight when any joiner puts a path before it", () => {
		for (const joiner of [":", ",", ";", "|", ")", "(", "["]) {
			const value = fresh();
			const text = shown(`/opt/bin${joiner}${value}\n`, "launchctl getenv X");
			expect(text, joiner).toBeDefined();
			expect(text, joiner).not.toContain(value);
		}
	});

	it("is put out of sight inside words shaped as a mark", () => {
		const value = fresh();
		const text = shown(`[secret ${"scrubbed"}: ${value}]\n`, "launchctl getenv X");
		expect(text).toBeDefined();
		expect(text).not.toContain(value);
	});

	it("is put out of sight as the text of a terminal's link", () => {
		const value = fresh();
		const link = `\x1b]8;;https://example.com\x07${value}\x1b]8;;\x07`;
		const text = shown(`${link}\n`, "launchctl getenv X");
		expect(text).toBe(
			`\x1b]8;;https://example.com\x07${VALUE_MARK}\x1b]8;;\x07\n`,
		);
	});

	it("leaves no mark where a terminal would read it as an escape", () => {
		const value = fresh();
		const text = shown(`\x1b${value}\n`, "launchctl getenv X");
		expect(text).toBe(`\x1b ${VALUE_MARK}\n`);
	});
});

describe("a coloured path in a printing of the environment", () => {
	it("reads as the path it is", () => {
		const path =
			"/usr/local/\x1b[01;31m\x1b[Kbin\x1b[m\x1b[K:/opt/python@3.11/bin:/usr/bin";
		const printed = `PATH=${path}\n`;
		expect(shown(printed, "env | grep --color=always bin")).toBe(printed);
	});

	// A highlight within an address can't be told from an escape joining a
	// token to one, so the address is put out of sight: the trade this
	// makes for failing closed.
	it("is put out of sight as an address split by a highlight", () => {
		const printed =
			"URL=https://ex\x1b[01;31m\x1b[Kample\x1b[m\x1b[K.com/v1/a1b2c3d4e5\n";
		expect(shown(printed, "env | grep --color=always ample")).toBe(
			"URL=[secret scrubbed: URL]\n",
		);
	});
});

describe("a long printing of the environment", () => {
	// The test's timeout bounds each: a scan reading a mark, or a word, from
	// every place one could start would cost its square.
	it("answers at once for words that only open a mark", () => {
		const printed = `${"[secret scrubbed: ".repeat(40_000)}\n`;
		expect(shown(printed, "launchctl getenv X")).toBeDefined();
	});

	it("answers at once for a long bare word its escapes split", () => {
		const printed = `${"a1\x1b[31m".repeat(50_000)}\n`;
		expect(shown(printed, "launchctl getenv X")).toBeDefined();
	});
});
