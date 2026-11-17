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
		for (const after of [...ends, "\x07", "''", "'\""]) {
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

	// A command kept beside a credential could hold the rest of it, so the
	// link goes out of sight with it: the trade this makes for failing
	// closed.
	it("is put out of sight with the link whose text it is", () => {
		const value = fresh();
		const link = `\x1b]8;;https://example.com\x07${value}\x1b]8;;\x07`;
		const text = shown(`${link}\n`, "launchctl getenv X");
		expect(text).toBe(`${VALUE_MARK}\n`);
	});

	it("is put out of sight within a terminal's command", () => {
		const value = fresh();
		const text = shown(
			`\x1b]0;${value}\x07\x1b]8;;https://h/?t=${value}\x07x\n`,
			"launchctl getenv X",
		);
		expect(text).toBe(
			`\x1b]0;${VALUE_MARK}\x07\x1b]8;;https://h/?t=${VALUE_MARK}\x07x\n`,
		);
	});

	it("is put out of sight within a command a string terminator ends", () => {
		const value = fresh();
		const text = shown(`\x1b]0;${value}\x1b\\x\n`, "launchctl getenv X");
		expect(text).toBe(`\x1b]0;${VALUE_MARK}\x1b\\x\n`);
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
		const splits = ["\x07", "\x1b]0;x\x07", "\x1b]8;;https://h\x07"];
		for (const split of [...splits, "\x1b]8;;file:///tmp\x1b\\"]) {
			const printed = `${value.slice(0, 8)}${split}${value.slice(8)}\n`;
			expect(shown(printed, "launchctl getenv X"), split).toBe(
				`${VALUE_MARK}\n`,
			);
		}
		const [one, other] = [value.slice(0, 8), value.slice(8)];
		for (const printed of [
			`${one}\x1b]0;${other}\x07\n`,
			`\x1b]0;${one}\x07${other}\n`,
			`\x1b]0;${one}\x07\x1b]0;${other}\x07\n`,
			`/x\x1b]0;${one}\x07${other}\n`,
			`/opt/bin:${one}\x1b]0;${other}\x07\n`,
			`https://h${one}\x1b]0;${other}\x07\n`,
			`\x1b]8;;https://h\x07${one}\x1b]0;${other}\x07\n`,
			`\x1b]8;;${one}\x07${other}\n`,
			`${one}\x1b]8;;${other}\x07\n`,
			`${one}:\x1b]0;${other}\x07\n`,
			`/x/${one.slice(0, 4)}\x1b[31m${one.slice(4)}\x1b]0;${other}\x07\n`,
			`/opt/bin/${one}\x1b]0;${other}/x\x07\n`,
			`/x/${one}\x1b]0;${other.slice(0, 4)}\x07\x1b]0;${other.slice(4)}\x07\n`,
		]) {
			expect(shown(printed, "launchctl getenv X"), printed).toBe(
				`${VALUE_MARK}\n`,
			);
		}
	});

	it("is put out of sight whole when its long half is in the open", () => {
		const value = fresh();
		const [short, long] = [value.slice(0, 12), value.slice(12)];
		for (const printed of [
			`\x1b]0;${short}\x07${long}\n`,
			`${long}\x1b]0;${short}\x07\n`,
			`\x1b]0;${short}=\x07${long}\n`,
		]) {
			expect(shown(printed, "launchctl getenv X"), printed).toBe(
				`${VALUE_MARK}\n`,
			);
		}
	});

	it("is put out of sight as an address's user", () => {
		for (const address of [
			`https://${fresh()}@host:443/x`,
			`https://${fresh()}@host/x`,
		]) {
			expect(shown(`API=${address}\n`), address).toBe(
				"API=[secret scrubbed: API]\n",
			);
		}
	});

	it("is put out of sight as an address's user or password, escaped", () => {
		for (const password of [fresh(), `${fresh()}%40x`]) {
			const text = shown(`API=postgres://app:${password}@db:5432/app\n`);
			expect(text, password).toBeDefined();
			expect(text, password).not.toContain(password.slice(0, 16));
		}
		for (const user of [
			`${fresh().slice(0, 10)}%2B${fresh().slice(0, 5)}`,
			"ABCDEFGHIJKLMNOP%31",
		]) {
			expect(shown(`API=https://${user}@host/x\n`), user).toBe(
				"API=[secret scrubbed: API]\n",
			);
		}
	});

	it("is put out of sight as an address's query, the address kept", () => {
		expect(shown(`API=https://h/cb?token=${fresh()}\n`)).toBe(
			`API=https://h/cb?token=${VALUE_MARK}\n`,
		);
	});

	it("holds an address's user that is a plain email or a coloured word", () => {
		for (const printed of [
			"GIT_URL=https://joel.gerber%40example.com@git.example.com/org/r.git\n",
			"GIT_URL=https://\x1b[01;31m\x1b[Kgit\x1b[m\x1b[K@github.com/org/repo\n",
		]) {
			expect(shown(printed), printed).toBeUndefined();
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
		const mark = "[secret scrubbed: GitHub token]";
		const printed = [
			`\x1b${value}`,
			`\x1b${github}`,
			`\x1b\x1b ${value}`,
			`\x1b[${github}`,
			`\x1b[1;${github}`,
			`\x1b[1 ${github}`,
			`\x1b[1 ;${github}`,
		];
		expect(shown(`${printed.join("\n")}\n`, "launchctl getenv X")).toBe(
			`${VALUE_MARK}\n${mark}\n${VALUE_MARK}\n${mark}\n${mark}\n${mark}\n${mark}\n`,
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
		for (const address of [
			"http://localhost:8080/api/v1/users2",
			"postgres://app@db:5432/app_production_2",
			"http://api_server:8080/api/v1/users2",
			"http://[::1]:8080/api/v1/users2",
		]) {
			const printed = `API=${address}\n`;
			expect(shown(printed), address).toBeUndefined();
		}
	});

	it("holds a long name with a digit that sets nothing", () => {
		for (const printed of [
			'declare -x AWS_ACCESS_KEY_ID_2=""\n',
			'declare -x npm_config_node18_path=""\n',
			"AWS_ACCESS_KEY_ID_2=\n",
		]) {
			expect(shown(printed), printed).toBeUndefined();
		}
	});

	// An empty variable's name in any other case can't be told from a
	// value's padding at its line's end, so it is put out of sight: the
	// trade this makes for failing closed.
	it("is put out of sight as an empty mixed-case name with a digit", () => {
		expect(shown("npm_config_node18_path=\n")).toBe(`${VALUE_MARK}=\n`);
	});

	it("holds a long name with a digit whose value opens a list", () => {
		for (const value of [":/opt/lib", "\\\\srv\\x", "&a=1", "|x"]) {
			const printed = `LD_LIBRARY_PATH_64=${value}\n`;
			expect(shown(printed), printed).toBeUndefined();
		}
	});

	it("holds a terminal's title and its shell's marks", () => {
		for (const printed of [
			"\x1b]0;user@mbp2: ~/src/py3\x07\x1b]1337;CurrentDir=/Users/joel\x07\n",
			"\x1b]0;joel@mbp: ~/src/service-v2\x07\n",
			"\x1b]0;joel@mbp: ~/src/service-v2\x07\x1b]1337;CurrentDir=/Users/joel\x07\n",
			"\x1b]8;;file://mbp/Users/joel/report2024.pdf\x07report2024.pdf\x1b]8;;\x07\n",
			"\x1b]8;;https://jira.example.com/browse/PROJ-1234\x07PROJ-1234\x1b]8;;\x07\n",
			"/srv/app\x1b]0;x\x07/data/v2/reports_2024\n",
		]) {
			expect(shown(printed, "launchctl getenv X"), printed).toBeUndefined();
		}
	});

	// A command's payload is judged joined to the text beside it too, so
	// half a credential in a title exempts nothing: a title run into a
	// path is put out of sight, the trade this makes for failing closed.
	it("is put out of sight as a title run into the text after it", () => {
		const printed = "\x1b]0;host12\x07/Users/joel/app\n";
		expect(shown(printed, "launchctl getenv X")).toBe(`${VALUE_MARK}\n`);
	});

	// Two commands' payloads side by side are read as one run, as a split
	// credential's would be: a shell's marks that run together into a long
	// mixed word are put out of sight, the trade this makes for failing
	// closed.
	it("is put out of sight as shell marks that run together", () => {
		const printed =
			"\x1b]1337;RemoteHost=joel@mbp2.local\x07\x1b]1337;CurrentDir=/Users/joel\x07\n";
		expect(shown(printed, "launchctl getenv X")).toBe(`${VALUE_MARK}\n`);
	});

	// A value in capitals with an underscore, as no base64 or hex value is
	// written, reads as a name before any equals: the trade that keeps an
	// empty variable's name, or one opening a list, readable.
	it("holds a capitals word with an underscore before its padding", () => {
		const printed = "environ({'B': ABCD_EF0123456789ABCDEF=,})\n";
		expect(shown(printed, "python3 -c 'import os;print(os.environ)'")).toBeUndefined();
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
		const marks = lines.map(
			(_, at) =>
				`LONG_SECRET_NAME_${at}=[secret scrubbed: LONG_SECRET_NAME_${at}]\n`,
		);
		const out = shown(lines.join(""))?.split("\n") ?? [];
		const wrong = marks.findIndex((mark, at) => `${out[at]}\n` !== mark);
		expect(wrong, `line ${wrong}: ${out[wrong]}`).toBe(-1);
		expect(out.length, "no line past the last mark").toBe(marks.length + 1);
	});

	it("answers at once for commands, addresses and sequences left open", () => {
		const github = `ghp_${"a1B2".repeat(9)}`;
		const printings: [string, boolean][] = [
			["\x1b]0;".repeat(100_000), false],
			[`\x1b]0;${"a1".repeat(100_000)}`, true],
			[`\x1b]0;${"a1 ".repeat(50_000)}\x07`, false],
			["://u@h:1/".repeat(50_000), false],
			["ab\x1b]0;cd\x07".repeat(50_000), false],
			[`/${"a1\x1b]0;b2\x07".repeat(50_000)}`, false],
			["a\x1b]0;1\x07".repeat(50_000), true],
			[`\x1b[${"1;".repeat(100_000)}${github}`, true],
		];
		for (const [printed, hides] of printings) {
			const text = shown(`${printed}\n`, "launchctl getenv X");
			expect(text !== undefined, printed.slice(0, 12)).toBe(hides);
			if (!hides) continue;
			expect(text, printed.slice(0, 12)).not.toContain("a1a1a1a1");
			expect(text, printed.slice(0, 12)).not.toContain(github);
			expect(text, printed.slice(0, 12)).not.toContain("1;[secret");
		}
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
