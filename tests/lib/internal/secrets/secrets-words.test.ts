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
import {
	scrubSecrets,
	scrubToolResult,
} from "../../../../lib/internal/secrets/secrets.ts";

const fresh = () => `z9${randomBytes(19).toString("hex")}`;
const VALUE_MARK = "[secret scrubbed: environment value]";

/**
 * The text a dump's answer shows once scrubbed, printed by `command`;
 * undefined when the scrub found nothing to put out of sight.
 */
function shown(printed: string, command = "printenv"): string | undefined {
	const answer = { content: [{ type: "text", text: printed }] };
	const part = scrubToolResult(answer, { command })?.content?.[0];
	return part?.type === "text" ? part.text : undefined;
}

describe("a bare value in a printing of the environment", () => {
	const python = "python3 -c 'import os;print(os.environ)'";

	it("is put out of sight when one equals of padding ends it before a quote, a comma or an escape", () => {
		for (const after of ["'", '"', ",", "\x1b[0m", "]", "\\n", "&b=1", ":"]) {
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

	it("is put out of sight within a terminal's command", () => {
		const value = fresh();
		const text = shown(
			`\x1b]0;${value}\x07\x1b]8;;https://h/?t=${value}\x07x\n`,
			"launchctl getenv X",
		);
		expect(text).toBe(
			`${VALUE_MARK}\x07\x1b]8;;https://h/?t=${VALUE_MARK}\x07x\n`,
		);
	});

	it("leaves no mark where a terminal would read it as an escape", () => {
		const value = fresh();
		const github = `ghp_${"a1B2".repeat(9)}`;
		const text = shown(`\x1b${value}\n\x1b${github}\n`, "launchctl getenv X");
		expect(text).toBe(
			`${VALUE_MARK}\n[secret scrubbed: GitHub token]\n`,
		);
	});
});

describe("what a printing of the environment keeps", () => {
	it("holds a coloured path, as the path it is", () => {
		const path =
			"/usr/local/\x1b[01;31m\x1b[Kbin\x1b[m\x1b[K:/opt/python@3.11/bin:/usr/bin";
		const printed = `PATH=${path}\n`;
		expect(shown(printed, "env | grep --color=always bin")).toBeUndefined();
	});

	it("holds an address with a port and a path", () => {
		const printed = "API=http://localhost:8080/api/v1/users2\n";
		expect(shown(printed)).toBeUndefined();
	});

	it("holds a long name with a digit that sets nothing", () => {
		const printed = 'declare -x AWS_ACCESS_KEY_ID_2=""\n';
		expect(shown(printed)).toBeUndefined();
	});

	it("holds the scrub's own mark for a long name with a digit", () => {
		const value = fresh();
		const known = [{ name: "AWS_ACCESS_KEY_ID_2", value }];
		const { text } = scrubSecrets(`AWS_ACCESS_KEY_ID_2=${value}\n`, known, {
			environment: true,
		});
		expect(text).toBe("AWS_ACCESS_KEY_ID_2=[secret scrubbed: AWS_ACCESS_KEY_ID_2]\n");
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
		expect(shown(printed, "launchctl getenv X")).toBeUndefined();
	});

	it("answers at once for a long bare word its escapes split", () => {
		const printed = `${"a1\x1b[31m".repeat(50_000)}\n`;
		expect(shown(printed, "launchctl getenv X")).toBeDefined();
	});
});
