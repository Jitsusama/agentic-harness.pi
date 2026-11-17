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
