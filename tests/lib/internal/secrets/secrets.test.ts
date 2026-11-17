/**
 * One scrub of a tool's whole answer, read by the command the call ran:
 * the secret-scrub extension and a host's tool round both answer with it,
 * so a conversation that loads no extension is scrubbed the same way.
 *
 * Every credential here is made as the test runs, so the repository never
 * holds a string shaped like a live one.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	dumpsEnvironment,
	readsAsDump,
	scrubOptionsOf,
	scrubSecrets,
	scrubToolPartial,
	scrubToolResult,
} from "../../../../lib/internal/secrets/secrets.ts";

const fresh = () => `z9${randomBytes(19).toString("hex")}`;
const MARK = "[secret scrubbed: OP_SESSION_ab12]";
const awsKey = `AK${"IA"}${"QQQQWWWWEEEERRRR"}`;

function dumpOf(value: string) {
	return {
		content: [
			{ type: "text", text: `OP_SESSION_ab12=${value}` },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		details: { tail: `OP_SESSION_ab12=${value}` },
		structuredContent: { output: `OP_SESSION_ab12=${value}`, exitCode: 0 },
	};
}

describe("a tool's answer scrubbed whole", () => {
	it("puts a printed environment's every value out of sight, in all three fields", () => {
		const value = fresh();
		const scrubbed = scrubToolResult(dumpOf(value), { command: "printenv" });
		expect(JSON.stringify(scrubbed)).not.toContain(value);
		expect(scrubbed).toEqual({
			content: [
				{ type: "text", text: `OP_SESSION_ab12=${MARK}` },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			details: { tail: `OP_SESSION_ab12=${MARK}` },
			structuredContent: { output: `OP_SESSION_ab12=${MARK}`, exitCode: 0 },
		});
	});

	it("reads a command that prints no environment as ordinary output", () => {
		const answer = dumpOf(fresh());
		expect(scrubToolResult(answer, { command: "cat notes.txt" })).toBe(
			undefined,
		);
		const keyed = {
			content: [{ type: "text", text: `found ${awsKey}` }],
		};
		expect(scrubToolResult(keyed, { command: "cat notes.txt" })).toEqual({
			content: [
				{ type: "text", text: "found [secret scrubbed: AWS access key]" },
			],
		});
	});

	it("names only the fields the answer has", () => {
		const scrubbed = scrubToolResult(
			{ content: [{ type: "text", text: `OP_SESSION_ab12=${fresh()}` }] },
			{ command: "env" },
		);
		expect(Object.keys(scrubbed ?? {})).toEqual(["content"]);
	});

	it("is undefined for an answer with nothing to hide", () => {
		expect(
			scrubToolResult(
				{ content: [{ type: "text", text: "all clean" }], details: { n: 1 } },
				{ command: "printenv" },
			),
		).toBe(undefined);
	});

	it("reads the command from any call's input, and none from one without", () => {
		expect(scrubOptionsOf({ command: "printenv HOME" })).toEqual({
			environment: true,
		});
		expect(scrubOptionsOf({ command: "ls" })).toEqual({ environment: false });
		for (const input of [undefined, null, "printenv", { command: 3 }]) {
			expect(scrubOptionsOf(input)).toEqual({ environment: false });
		}
	});

	it("finds nothing more in an answer it already scrubbed, as when the extension and a host's round both scrub", () => {
		const input = { command: "printenv" };
		const once = scrubToolResult(dumpOf(fresh()), input);
		expect(once).toBeDefined();
		expect(scrubToolResult(once ?? {}, input)).toBe(undefined);
	});
});

describe("a printing of the environment, however it is asked for", () => {
	const dumps = [
		"/usr/bin/env",
		"/usr/bin/printenv",
		"command env",
		"env -0",
		"env FOO=1",
		"env -u HOME | sort",
		"env --unset=HOME",
		"export",
		"export | grep PATH",
		"declare -x",
		"declare -p",
		"declare -px",
		"declare",
		"builtin set",
		"set",
		"python3 -c 'import os;print(os.environ)'",
		"python3 -c 'import os, json; print(json.dumps(dict(os.environ)))'",
		"node -e 'console.log(process.env)'",
		"ruby -e 'p ENV.to_h'",
		"perl -e 'print \"$_=$ENV{$_}\\n\" for keys %ENV'",
		"cd /x\nenv\necho ok",
		"env 2>&1 | sort",
		"export 2>/dev/null",
		"set # every variable",
		"bash -c set",
		"sh -c 'export'",
		"ssh build-host set",
		"{ set; } > out.txt",
		"time env",
		"python3 -c 'import os; print(os.environb)'",
		"python3 -c 'from os import environ; print(environ)'",
		"node --eval 'console.log(process.env)'",
		"deno eval 'console.log(Deno.env.toObject())'",
		"bun -e 'console.log(Bun.env)'",
		"php -r 'print_r($_ENV);'",
		"ruby -e 'puts ENV.values'",
		"python3 <<EOF\nimport os\nprint(os.environ)\nEOF",
		"awk 'BEGIN { for (k in ENVIRON) print k \"=\" ENVIRON[k] }'",
		"jq -n '$ENV'",
		"jq -n env",
		"docker inspect web",
		"ps -E -p 1",
		"ps -wwE 1",
		"{ /usr/bin/env; }",
		"echo 'import os; print(os.environ)' | python3",
		"cat <<'EOF' | python3\nimport os\nprint(os.environ)\nEOF",
		"printf 'console.log(process.env)' | node",
		"cat > dump.py <<'EOF'\nimport os\nprint(os.environ)\nEOF\npython3 dump.py",
		"awk 'BEGIN{n=0; for (k in ENVIRON) print k}'",
		"gawk 'BEGIN { for (k in ENVIRON) print k }'",
		"jq -n '{} | env'",
		"cat /proc/self/task/1/environ",
		"podman inspect web",
		"docker compose config",
		"systemctl show -p Environment nginx",
		"kubectl set env deploy/web --list",
		"echo 'import os; print(os.environ)' | python3 -u",
		"echo 'import os; print(os.environ)' | python3 2>&1",
		"echo 'import os; print(os.environ)' | sudo -E python3",
		"printf 'console.log(process.env)' | /usr/bin/env node",
		"env --unset HOME | sort",
		"env -iu HOME",
		"env -0u HOME",
		"env -P /usr/bin",
		"bash -lc set",
	];
	for (const command of dumps) {
		it(`is known as one: ${command}`, () => {
			expect(
				dumpsEnvironment(command),
				`${command} prints the environment`,
			).toBe(true);
		});
	}

	const runs = [
		"env FOO=1 cargo test",
		"/usr/bin/env python3 script.py",
		"export FOO=1",
		"set -euo pipefail; make",
		"nix-env -q",
		"python3 -c 'import os; print(os.environ[\"HOME\"])'",
		"python3 -c 'import os; print(os.environ.get(\"HOME\"))'",
		"node -e 'console.log(process.env.HOME)'",
		"rg process.env src",
		"grep -rn 'os.environ' .",
		"git grep 'getenv()'",
		"python3 script.py # reads os.environ",
		"ps -o pid,comm -p 1",
		"jq -r .env package.json",
		'env FOO="1" cargo test',
		"env NODE_OPTIONS='--max-old-space-size=4096' node build.js",
		'env -u "HOME" make',
		"cat package.json | node scripts/check.js",
		"docker compose up -d",
		"systemctl show nginx",
		'env "FOO=1" make',
		"env 'NODE_OPTIONS=--max-old-space-size=4096' node build.js",
		"env --chdir /srv make",
	];
	for (const command of runs) {
		it(`is not one: ${command}`, () => {
			expect(
				dumpsEnvironment(command),
				`${command} prints only its own output`,
			).toBe(false);
		});
	}

	// The test's timeout bounds these: a rule that tries every reading of
	// a long run takes most of a minute.
	it("reads a long run of env's options in one way, so it answers at once", () => {
		expect(
			dumpsEnvironment(`env${" -uA".repeat(28)} x`),
			"env with options then a command runs the command",
		).toBe(false);
		expect(
			dumpsEnvironment(`env${" A=1".repeat(28)} x`),
			"env setting variables then a command runs the command",
		).toBe(false);
	});

	// The test's timeout bounds this: a rule that reads an interpreter's
	// words across lines tries every later line from each one it names.
	it("answers at once for a long command naming an interpreter on each line", () => {
		expect(
			dumpsEnvironment("echo node x\n".repeat(20_000)),
			"no script is run",
		).toBe(false);
	});

	it("has env -0's every NUL-ended value scrubbed", () => {
		const access = fresh();
		const { text } = scrubSecrets(
			`HOME=/h\0PROXY_ACCESS=${access}\0LANG=en\0`,
			[],
			{ environment: true },
		);
		expect(text).not.toContain(access);
		expect(text).toContain("\0PROXY_ACCESS=[secret scrubbed: PROXY_ACCESS]\0");
	});

	it("has a Python environment's every value scrubbed, read by its command", () => {
		const secret = fresh();
		const access = fresh();
		const printed = `environ({'PATH': '/usr/bin:/bin', 'FOO_SECRET': '${secret}', 'PROXY_ACCESS': '${access}'})`;
		const scrubbed = scrubToolResult(
			{ content: [{ type: "text", text: printed }] },
			{ command: "python3 -c 'import os;print(os.environ)'" },
			[],
		);
		const kept = JSON.stringify(scrubbed);
		expect(kept.includes(secret), "the secret's value is gone").toBe(false);
		expect(kept.includes(access), "a value of no known name is gone").toBe(
			false,
		);
		expect(kept).toContain("'PATH': '/usr/bin:/bin'");
	});
});

describe("an output that reads as a printing of the environment", () => {
	const variables = (access: string) => [
		"HOME=/home/someone",
		"SHELL=/bin/zsh",
		`PROXY_ACCESS=${access}`,
		"LANG=en_CA.UTF-8",
		"TERM=xterm-256color",
	];

	it("is one with five lines setting a variable, whatever printed it", () => {
		const access = fresh();
		const printed = ["starting", ...variables(access)].join("\n");
		expect(readsAsDump(printed), "five of six lines set a variable").toBe(
			true,
		);
		const { text } = scrubSecrets(printed, []);
		expect(text).not.toContain(access);
		expect(text).toContain("PROXY_ACCESS=[secret scrubbed: PROXY_ACCESS]");
		expect(text).toContain("HOME=/home/someone");
	});

	it("is one through a tool's whole answer, whatever command ran", () => {
		const access = fresh();
		const scrubbed = scrubToolResult(
			{ content: [{ type: "text", text: variables(access).join("\n") }] },
			{ command: "./print-settings" },
			[],
		);
		expect(JSON.stringify(scrubbed)).not.toContain(access);
	});

	it("is not one with fewer than five such lines", () => {
		const printed = variables(fresh()).slice(0, 4).join("\n");
		expect(readsAsDump(printed), "four lines are not a dump").toBe(false);
		expect(scrubSecrets(printed, []).text).toBe(printed);
	});

	it("is not one when such lines are under half of it, none five in a row", () => {
		const printed = ["begin"]
			.concat(...variables(fresh()).map((line, i) => [line, `step ${i}`]))
			.join("\n");
		expect(readsAsDump(printed), "five of eleven lines are not half").toBe(
			false,
		);
	});

	it("is one when such lines are half of it, the fewest that make one", () => {
		const printed = variables(fresh())
			.flatMap((line, i) => [line, `step ${i}`])
			.join("\n");
		expect(readsAsDump(printed), "five of ten lines are half").toBe(true);
	});

	it("is one with five such lines in a row, inside a longer output", () => {
		const access = fresh();
		const steps = Array.from({ length: 12 }, (_, i) => `step ${i} done`);
		const printed = [...steps, ...variables(access)].join("\n");
		expect(readsAsDump(printed), "five in a row are a dump").toBe(true);
		expect(scrubSecrets(printed, []).text).not.toContain(access);
	});

	it("counts no blank line towards its length", () => {
		const printed = variables(fresh()).join("\n\n\n");
		expect(readsAsDump(printed), "blank lines hold nothing").toBe(true);
	});

	it("is one with env -0's NUL-ended lines", () => {
		const access = fresh();
		const printed = `${variables(access).join("\0")}\0`;
		expect(readsAsDump(printed), "NUL ends each line").toBe(true);
		expect(scrubSecrets(printed, []).text).not.toContain(access);
	});

	it("is not one for log lines of several pairs, nor pinned packages", () => {
		const logged = Array.from(
			{ length: 6 },
			(_, i) => `ts=2026-11-17T10:0${i} level=info msg=step${i}`,
		).join("\n");
		expect(readsAsDump(logged), "logfmt sets no one variable").toBe(false);
		const frozen = ["requests==2.31.0", "urllib3==2.0.7", "idna==3.4"]
			.concat(["certifi==2023.7.22", "charset-normalizer==3.3.0"])
			.join("\n");
		expect(readsAsDump(frozen), "a pin is not a variable").toBe(false);
	});

	it("is judged before a credential in it is marked", () => {
		const secret = fresh();
		const access = fresh();
		// Five lines, one of which is marked before the rest are read.
		const printed = [
			...variables(access).slice(0, 2),
			`FOO_SECRET=${secret}`,
			...variables(access).slice(2, 4),
		].join("\n");
		const { text } = scrubSecrets(printed, [
			{ name: "FOO_SECRET", value: secret },
		]);
		expect(text.includes(secret), "the known value is gone").toBe(false);
		expect(text.includes(access), "a value of no known name is gone").toBe(
			false,
		);
	});

	it("is judged before a credential's shape in it is marked", () => {
		const access = fresh();
		const steps = Array.from({ length: 12 }, (_, i) => `step ${i} done`);
		const lines = variables(access);
		const printed = [
			...steps,
			...lines.slice(0, 3),
			`GITHUB_TOKEN=ghp_${"a1B2".repeat(9)}`,
			...lines.slice(3),
		].join("\n");
		const { text } = scrubSecrets(printed, []);
		expect(text.includes(access), "a value of no known name is gone").toBe(
			false,
		);
	});

	it("has a value's every word read as env prints it, unquoted", () => {
		const access = fresh();
		const printed = [
			...variables(fresh()).slice(0, 4),
			`PROXY_AUTH=Basic ${access}`,
		].join("\n");
		expect(readsAsDump(printed), "a spaced value sets one variable").toBe(
			true,
		);
		expect(scrubSecrets(printed, []).text).not.toContain(access);
	});

	it("has the rest of a value read when a mark cut it short", () => {
		const known = fresh();
		const access = fresh();
		const printed = [
			...variables(fresh()),
			`CREDENTIALS=${known}:${access}`,
		].join("\n");
		const { text } = scrubSecrets(printed, [
			{ name: "FOO_SECRET", value: known },
		]);
		expect(text.includes(known), "the known value is gone").toBe(false);
		expect(text.includes(access), "the rest of the value is gone").toBe(
			false,
		);
	});

	it("has only its lines that set a variable read as a dump", () => {
		const logged = "id=a1b2c3d4e5f6a7b8c9d0 level=info msg=started";
		const printed = [logged, ...variables(fresh())].join("\n");
		expect(scrubSecrets(printed, []).text).toContain(logged);
	});

	it("has a quoted value's every word read, as a dump's", () => {
		const access = fresh();
		const printed = [
			...variables(fresh()),
			`PROXY_AUTH="user ${access}"`,
		].join("\n");
		expect(scrubSecrets(printed, []).text).not.toContain(access);
	});

	it("is one with lines a carriage return ends", () => {
		const access = fresh();
		const { text } = scrubSecrets(variables(access).join("\r"), []);
		expect(text).not.toContain(access);
	});

	it("is one still when a progress line redrawn between its lines counts once", () => {
		const values = Array.from({ length: 5 }, fresh);
		const printed = values
			.map((value, at) => `NAME_${at}=${value}\n  10%\r  50%\r 100%\n`)
			.join("");
		const { text } = scrubSecrets(printed, []);
		for (const value of values) expect(text).not.toContain(value);
	});

	// The test's timeout bounds this too: a stretch a return ends is read on
	// its own, so a long run of them is read once each.
	it("answers at once for a long run of carriage returns, a redrawn line no dump", () => {
		const printed = `${"A=1\rready\r".repeat(100_000)}---`;
		expect(readsAsDump(printed), "one redrawn line is no dump").toBe(false);
		expect(scrubSecrets(printed, []).text).toBe(printed);
	});

	it("is none for one line redrawn five times over", () => {
		const printed = `${"progress=10%\r".repeat(5)}done\n`;
		expect(readsAsDump(printed), "one redrawn line is no dump").toBe(false);
	});

	it("is one with five lines in a row setting the same name", () => {
		const printed = `${"A=1\n".repeat(5)}${"word\n".repeat(6)}`;
		expect(readsAsDump(printed), "five lines set A").toBe(true);
	});

	// The test's timeout bounds this: a name looked for from every letter
	// of a long run of flags is read again from each.
	it("answers at once for a line declaring a long run of flags", () => {
		const printed = `${`declare -${"x".repeat(60_000)} A=1\n`.repeat(2)}`;
		expect(readsAsDump(printed), "two lines are no dump").toBe(false);
	});

	// The test's timeout bounds this: a rule whose line start reads on past
	// a newline tries every blank line from every blank line.

	it("answers at once for a dump followed by many blank lines", () => {
		const printed = `${"A=1\n".repeat(5)}${"\n".repeat(200_000)}---`;
		expect(scrubSecrets(printed, []).text).toBe(printed);
		expect(scrubSecrets(printed, [], { environment: true }).text).toBe(
			printed,
		);
	});

	it("keeps its other lines' long words when only its lines make it one", () => {
		const access = fresh();
		const commit = "3f9c2a7be41d08e5c6a1f2b3d4e5f60718293a4b";
		const path = "build/output/a1b2c3d4e5f6a7b8c9d0/index.js";
		const printed = [`commit ${commit}`, `wrote ${path}`, ...variables(access)]
			.join("\n");
		const { text } = scrubSecrets(printed, []);
		expect(text).not.toContain(access);
		expect(text).toContain(commit);
		expect(text).toContain(path);
	});
});

describe("a stream's partial answer, which its settled answer replaces", () => {
	const partialOf = (text: string) => ({
		content: [{ type: "text", text }],
		details: { tail: text },
	});

	it("has a line setting a secret-looking value scrubbed before five arrive", () => {
		const value = fresh();
		const printed = `loading\nPROXY_CRED=${value}\n`;
		const scrubbed = scrubToolPartial(partialOf(printed), {
			command: "./show-config",
		});
		expect(JSON.stringify(scrubbed)).not.toContain(value);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "loading\nPROXY_CRED=[secret scrubbed: PROXY_CRED]\n",
		});
	});

	it("keeps a line whose value looks like no secret, and every other line", () => {
		const printed = "VERSION=1.2.3\nHOME=/home/a\nwrote a1b2c3d4e5f6a7b8c9d0e1";
		expect(
			scrubToolPartial(partialOf(printed), { command: "./show-config" }),
		).toBeUndefined();
	});

	it("leaves a settled answer judged by its count", () => {
		const value = fresh();
		const printed = `loading\nPROXY_CRED=${value}`;
		expect(
			scrubToolResult(partialOf(printed), { command: "./show-config" }),
		).toBeUndefined();
	});

	it("has a line still being written put out of sight however short its value", () => {
		const mark = "[secret scrubbed: PROXY_CRED]";
		for (const [cut, shown] of [
			[fresh().slice(0, 10), mark],
			["0123456789", mark],
			['"Basic ab12', `"${mark}`],
		]) {
			const scrubbed = scrubToolPartial(
				partialOf(`loading\nPROXY_CRED=${cut}`),
				{ command: "./show-config" },
			);
			expect(scrubbed?.content?.[0], `${cut} is cut short`).toEqual({
				type: "text",
				text: `loading\nPROXY_CRED=${shown}`,
			});
		}
	});

	it("keeps a line still being written that sets no one variable", () => {
		for (const open of [
			"requests==2.31.0",
			"    total = compute(x)",
			"key => value",
			"level=info msg=listening",
		]) {
			expect(
				scrubToolPartial(partialOf(`building\n${open}`), { command: "./x" }),
				open,
			).toBeUndefined();
		}
	});

	it("has a line still being written put out of sight when its value holds a space", () => {
		const scrubbed = scrubToolPartial(
			partialOf("loading\nPROXY_AUTH=Basic ab12cd34"),
			{ command: "./show-config" },
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "loading\nPROXY_AUTH=[secret scrubbed: PROXY_AUTH]",
		});
	});

	it("has a dump's line still being written put out of sight however it sets apart its value", () => {
		const scrubbed = scrubToolPartial(partialOf("PROXY_CRED => ab12cd"), {
			command: "printenv",
		});
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "PROXY_CRED => [secret scrubbed: PROXY_CRED]",
		});
	});

	it("has a line still being written put out of sight past a terminal's codes", () => {
		const scrubbed = scrubToolPartial(
			partialOf("downloading 40%\r\x1b[KPROXY_CRED=ab12"),
			{ command: "./show-config" },
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "downloading 40%\r\x1b[KPROXY_CRED=[secret scrubbed: PROXY_CRED]",
		});
	});

	it("has a value a highlight splits put out of sight whole", () => {
		const [head, tail] = [fresh().slice(0, 12), fresh().slice(0, 12)];
		const lit = `\x1b[01;31m\x1b[KXYZ\x1b[m\x1b[K`;
		const scrubbed = scrubToolPartial(
			partialOf(`TOKEN=${head}${lit}${tail}\nready`),
			{ command: "printenv | grep --color=always XYZ" },
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "TOKEN=[secret scrubbed: TOKEN]\nready",
		});
	});

	// The test's timeout bounds this: a word that may start after each
	// bracket and run to the line's end is read again from every one.
	it("answers at once for a long line of brackets ending in an equals", () => {
		const printed = `A=${"x]".repeat(25_000)}=`;
		expect(
			scrubToolPartial(partialOf(`${printed}\n`), { command: "./x" }),
		).toBeUndefined();
	});

	it("has a line still being written put out of sight past a mark it holds", () => {
		const known = fresh();
		const cut = fresh().slice(0, 8);
		const scrubbed = scrubToolPartial(
			partialOf(`loading\nCREDENTIALS=${known}:${cut}`),
			{ command: "./show-config" },
			[{ name: "FOO_SECRET", value: known }],
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "loading\nCREDENTIALS=[secret scrubbed: CREDENTIALS]",
		});
	});

	it("keeps a short value on a line that has ended", () => {
		const printed = "PORT=8080\nready";
		expect(
			scrubToolPartial(partialOf(printed), { command: "./serve" }),
		).toBeUndefined();
	});

	it("reads a line a carriage return ends, or a colour opens, as one setting a variable", () => {
		const value = fresh();
		const mark = "[secret scrubbed: PROXY_CRED]";
		for (const [before, after] of [
			["downloading 40%\r", ""],
			["\x1b[32m", "\x1b[0m"],
			["downloading 40%\r\x1b[K", ""],
			["\x1b[2K\r\x1b[?25l", ""],
			["\x1b[01;31m\x1b[K", "\x1b[m\x1b[K"],
			["\x1b(B\x1b[m", ""],
			["\x1b7\x1b[>4;2m", ""],
		]) {
			const scrubbed = scrubToolPartial(
				partialOf(`${before}PROXY_CRED=${value}${after}\n`),
				{ command: "./show-config" },
			);
			expect(scrubbed?.content?.[0], JSON.stringify(before)).toEqual({
				type: "text",
				text: `${before}PROXY_CRED=${mark}${after}\n`,
			});
		}
	});

	it("keeps a colour's reset, and a value only the reset made look like a secret", () => {
		const printed = "\x1b[32mEDITOR_THEME=solarizeddarkmode\x1b[0m\nready";
		expect(
			scrubToolPartial(partialOf(printed), { command: "./show-config" }),
		).toBeUndefined();
	});

	it("has a bare value a colour wraps put out of sight in a dump", () => {
		const value = fresh();
		const scrubbed = scrubToolPartial(
			partialOf(`\x1b[32m${value}\x1b[0m\nready`),
			{ command: "launchctl getenv PROXY_CRED" },
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "\x1b[32m[secret scrubbed: environment value]\x1b[0m\nready",
		});
	});

	it("has a bare value put out of sight when an escape it can't read, or one cut short, follows it", () => {
		const value = fresh();
		const scrubbed = scrubToolPartial(
			partialOf(`\x1b[32m${value}\x1b[0`),
			{ command: "launchctl getenv PROXY_CRED" },
		);
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "\x1b[32m[secret scrubbed: environment value]\x1b[0",
		});
		const linked = `${value}\x1b]8;;\x1b\\ ready`;
		expect(scrubSecrets(linked, [], { environment: true }).text).toBe(
			"[secret scrubbed: environment value]\x1b]8;;\x1b\\ ready",
		);
	});

	it("has a bare value holding a bracket put out of sight whole", () => {
		const value = `${fresh().slice(0, 8)}]${fresh().slice(0, 12)}`;
		const scrubbed = scrubToolPartial(partialOf(`${value}\nready`), {
			command: "launchctl getenv PROXY_CRED",
		});
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "[secret scrubbed: environment value]\nready",
		});
	});

	it("has a credential put out of sight when a bracket joins it to a path", () => {
		const value = fresh();
		const scrubbed = scrubToolPartial(partialOf(`/opt/bin]${value}\nready`), {
			command: "launchctl getenv PROXY_CRED",
		});
		expect(scrubbed).toBeDefined();
		expect(JSON.stringify(scrubbed)).not.toContain(value);
	});

	it("has a bare value its padding ends put out of sight", () => {
		const value = `${fresh().slice(0, 30)}Q`;
		const scrubbed = scrubToolPartial(partialOf(`${value}==\nready`), {
			command: "launchctl getenv PROXY_CRED",
		});
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "[secret scrubbed: environment value]==\nready",
		});
	});

	it("has a bare value put out of sight past words that only open a mark", () => {
		const value = fresh();
		const printed = `[secret ${"scrubbed"}: x\n${value}\n]`;
		const scrubbed = scrubToolPartial(partialOf(printed), {
			command: "launchctl getenv PROXY_CRED",
		});
		expect(scrubbed).toBeDefined();
		expect(JSON.stringify(scrubbed)).not.toContain(value);
	});

	it("has a credential put out of sight when only escapes join it to an address", () => {
		const value = fresh();
		const printed = `https://api.example.com\x1b[0m\x1b[33m${value}\nready`;
		const scrubbed = scrubToolPartial(partialOf(printed), {
			command: "printenv",
		});
		expect(scrubbed).toBeDefined();
		expect(JSON.stringify(scrubbed)).not.toContain(value);
	});

	// The test's timeout bounds this: escapes a word may hold, ending in a
	// break, would let a word start again inside each one.
	it("answers at once for a long line of escapes that end in a break", () => {
		for (const escape of ["\x1b=", "\x1b[]", "\x1b['m"]) {
			const printed = `A=${escape.repeat(25_000)}x=\n`;
			expect(
				scrubToolPartial(partialOf(printed), { command: "./x" }),
				JSON.stringify(escape),
			).toBeUndefined();
		}
	});

	// The test's timeout bounds this: the escapes closing a value, looked
	// for from every escape in a run of them, cost the run's square.
	it("answers at once for a value holding a long run of escapes", () => {
		const value = `x${"\x1b[m".repeat(60_000)}abcdef1234567890`;
		const scrubbed = scrubToolPartial(partialOf(`A=${value}\n`), {
			command: "./x",
		});
		expect(scrubbed?.content?.[0]).toEqual({
			type: "text",
			text: "A=[secret scrubbed: A]\n",
		});
	});

	it("is read as a dump's whole when its command prints the environment", () => {
		const value = fresh();
		const scrubbed = scrubToolPartial(partialOf(`starting ${value}`), {
			command: "printenv",
		});
		expect(scrubbed).toBeDefined();
		expect(JSON.stringify(scrubbed)).not.toContain(value);
	});
});
