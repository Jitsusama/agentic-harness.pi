/**
 * The words of a printing of the environment, each judged on its own: a
 * value reads as no variable's name for the equals its padding ends in,
 * nor is exempted by a path or an address any joiner puts before it, nor
 * by words shaped as a mark around it, nor split by a bell; a terminal's
 * command has its payload judged as words; a coloured path, an address's
 * port and a variable's name read as they are; and no mark lands where a
 * terminal would read it as an escape. A long printing costs its length.
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

	it("is put out of sight when one equals of padding ends it before what ends a value", () => {
		const ends = ["'", '"', ",", "\x1b[0m", "]", "\\n", "&b=1", ":", "|"];
		for (const after of [...ends, "\x07", "''"]) {
			const value = `${fresh()}Q`;
			const text = shown(`environ({'A': '1', 'B': ${value}=${after}})\n`, python);
			expect(text, JSON.stringify(after)).toBe(
				`environ({'A': '1', 'B': ${VALUE_MARK}=${after}})\n`,
			);
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

	// A link's address and text are one word, its escapes read past, so a
	// credential in either puts the link out of sight whole but its opening.
	it("is put out of sight as the text of a terminal's link", () => {
		const value = fresh();
		const link = `\x1b]8;;https://example.com\x07${value}\x1b]8;;\x07`;
		const text = shown(`${link}\n`, "launchctl getenv X");
		expect(text).toBe(`\x1b]8;;${VALUE_MARK}\x1b]8;;\x07\n`);
	});

	it("is put out of sight within a terminal's command", () => {
		const value = fresh();
		const text = shown(
			`\x1b]0;${value}\x07\x1b]8;;https://h/?t=${value}\x07x\n`,
			"launchctl getenv X",
		);
		expect(text).toBe(`\x1b]0;${VALUE_MARK}=${VALUE_MARK}\n`);
	});

	it("is put out of sight within a command a string terminator ends", () => {
		const value = fresh();
		const text = shown(`\x1b]0;${value}\x1b\\x\n`, "launchctl getenv X");
		expect(text).toBe(`\x1b]0;${VALUE_MARK}\n`);
	});

	it("is put out of sight on the line after a command left open", () => {
		const value = fresh();
		const text = shown(`\x1b]0;t\n${value}\n\x07\n`, "launchctl getenv X");
		expect(text).toBe(`\x1b]0;t\n${VALUE_MARK}\n\x07\n`);
	});

	it("is put out of sight when padding ends it before a link's bell", () => {
		const value = `${fresh()}Q`;
		const text = shown(
			`\x1b]8;;https://h/?t=${value}=\x07x\n`,
			"launchctl getenv X",
		);
		expect(text).toBe(`\x1b]8;;https://h/?t=${VALUE_MARK}=\x07x\n`);
	});

	it("is put out of sight when a bell or a command splits it", () => {
		const value = fresh().slice(0, 16);
		for (const split of ["\x07", "\x1b]0;x\x07"]) {
			const printed = `${value.slice(0, 8)}${split}${value.slice(8)}\n`;
			expect(shown(printed, "launchctl getenv X"), split).toBe(
				`${VALUE_MARK}\n`,
			);
		}
	});

	it("is put out of sight behind a port no address's host leads", () => {
		const value = fresh();
		const text = shown(`/opt/bin:12/${value}\n`, "launchctl getenv X");
		expect(text).toBe(`${VALUE_MARK}\n`);
		const secret = `AbCdEfGh${fresh()}`;
		const address = shown(`R=redis://:12/${secret}@host\n`);
		expect(address).toBeDefined();
		expect(address).not.toContain(secret);
	});

	it("leaves no mark where a terminal would read it as an escape", () => {
		const value = fresh();
		const github = `ghp_${"a1B2".repeat(9)}`;
		const printed = `\x1b${value}\n\x1b${github}\n\x1b\x1b ${value}\n`;
		expect(shown(printed, "launchctl getenv X")).toBe(
			`${VALUE_MARK}\n[secret scrubbed: GitHub token]\n${VALUE_MARK}\n`,
		);
	});

	it("leaves the scrub's own mark whole after a bare escape", () => {
		const value = fresh();
		const known = [{ name: "AWS_ACCESS_KEY_ID_2", value }];
		const { text } = scrubSecrets(`\x1b${value}\n`, known, {
			environment: true,
		});
		expect(text).toBe("[secret scrubbed: AWS_ACCESS_KEY_ID_2]\n");
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
		for (const printed of [
			'declare -x AWS_ACCESS_KEY_ID_2=""\n',
			"AWS_ACCESS_KEY_ID_2=\n",
		]) {
			expect(shown(printed), printed).toBeUndefined();
		}
	});

	it("holds a long name with a digit whose value opens a list", () => {
		for (const value of [":/opt/lib", "\\\\srv\\x", "&a=1", "|x"]) {
			const printed = `LD_LIBRARY_PATH_64=${value}\n`;
			expect(shown(printed), printed).toBeUndefined();
		}
	});

	it("holds a terminal's title and its shell's marks", () => {
		const printed =
			"\x1b]0;~/projects/agentic\x07\x1b]1337;CurrentDir=/Users/joel\x07\n";
		expect(shown(printed, "launchctl getenv X")).toBeUndefined();
	});

	it("holds the scrub's own mark for a long name with a digit", () => {
		const value = fresh();
		const known = [{ name: "AWS_ACCESS_KEY_ID_2", value }];
		const { text } = scrubSecrets(`AWS_ACCESS_KEY_ID_2=${value}\n`, known, {
			environment: true,
		});
		expect(text).toBe("AWS_ACCESS_KEY_ID_2=[secret scrubbed: AWS_ACCESS_KEY_ID_2]\n");
		expect(shown(`AWS_ACCESS_KEY_ID_2=${fresh()}\n`)).toBe(
			"AWS_ACCESS_KEY_ID_2=[secret scrubbed: AWS_ACCESS_KEY_ID_2]\n",
		);
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

	it("answers at once for many long names, each with its own mark", () => {
		const lines = Array.from(
			{ length: 60_000 },
			(_, at) => `LONG_SECRET_NAME_${at}=${fresh()}\n`,
		);
		const text = shown(lines.join(""));
		expect(text?.startsWith("LONG_SECRET_NAME_0=[secret scrubbed: "), text?.slice(0, 80)).toBe(true);
	});

	it("answers at once for a run of escapes before a mark", () => {
		const printed = `${"\x1b ".repeat(100_000)}${fresh()}\n`;
		expect(shown(printed, "launchctl getenv X")).toBe(`${VALUE_MARK}\n`);
	});

	it("answers at once for a long bare word its escapes split", () => {
		const printed = `${"a1\x1b[31m".repeat(50_000)}\n`;
		expect(shown(printed, "launchctl getenv X")).toBeDefined();
	});
});
