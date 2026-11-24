/**
 * merge-gate.sh as review_offer merge runs it: bash running the script as
 * it stands, in a clone of a bare origin with this harness's Biome and
 * vitest installed, the commit to merge as its last word. Each case
 * commits a change on a branch off a main that holds a Biome config, the
 * package.json pinning Biome, and the package's two count rules with
 * one script waiting on its suppression, so only the change's own files
 * are judged. A change that passes goes on to host-gate.sh,
 * which lets a change that touches nothing hosts run through without a
 * test:host run.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isRecord } from "../../lib/internal/record.ts";
import {
	bareOrigin,
	cloneAt,
	folder,
	removeAll,
} from "../lib/internal/carry/support/machines.ts";
import { git } from "../support/git-fixture.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it runs changes alone: merge-gate.sh, from its path below, and the
// host-gate.sh it runs in turn.
import "../../scripts/host-gate.sh";
import "../../scripts/merge-gate.sh";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const GATE = join(ROOT, "scripts", "merge-gate.sh");
/** Biome's own launcher, as this checkout installed it. */
const BIOME = realpathSync(
	join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome"),
);
/** vitest's own launcher, as this checkout installed it. */
const VITEST = realpathSync(join(ROOT, "node_modules", "vitest", "vitest.mjs"));
/** Where the package rules on code live, here and in the fixture. */
const CODE_RULES = "tests/package/code";
/** The package rules whose counts only fall, which the gate runs, and what they import. */
const COUNT_RULES = [
	"every-long-file-says-why.test.ts",
	"linters-stay-on.test.ts",
	"package-files.ts",
];
/** The long-file rule's list on main: nothing waits. */
const LONG_LIST = `${CODE_RULES}/long-files-waiting.txt`;
/** The suppression rule's list, whose one line on main is OLD's. */
const SUPPRESSION_LIST = `${CODE_RULES}/suppressions-waiting.txt`;
/** A script on main that turns shellcheck off once, and waits. */
const OLD = "scripts/old.sh";
/** A script that turns shellcheck off once. */
const LOOSE = "#!/usr/bin/env bash\n# shellcheck disable=SC2086\necho $1\n";
/** The suppression list holding `lines`, under its comment. */
const suppressionList = (...lines: string[]): string =>
	["# Waiting.", ...lines, ""].join("\n");
/**
 * Each case's gate starts vitest, which takes seconds on a loaded machine,
 * so a case has longer than vitest's five-second default.
 */
const GATE_TIMEOUT_MS = 60_000;
/** The lines past which a code file must say why it's long. */
const LONG_FILE_LINES = 800;

/** The Biome version this harness pins. */
const PINNED = biomePin(readFileSync(join(ROOT, "package.json"), "utf8"));
/** A config judging as the harness does: tabs, and the recommended rules. */
const CONFIG = `{ "formatter": { "indentStyle": "tab" } }\n`;

const made: string[] = [];
afterEach(() => removeAll(made));

/** The Biome version a package.json pins. */
function biomePin(text: string): string {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !isRecord(parsed.devDependencies)) return "";
	const pin = parsed.devDependencies["@biomejs/biome"];
	return typeof pin === "string" ? pin : "";
}

/** A package.json pinning Biome at `version`. */
function packageJson(version: string): string {
	return `${JSON.stringify(
		{ name: "h", devDependencies: { "@biomejs/biome": version } },
		null,
		"\t",
	)}\n`;
}

/**
 * A harness clone whose main holds a Biome config and pin and the count
 * rules with nothing waiting, Biome and vitest installed.
 */
async function harness(): Promise<string> {
	const origin = await bareOrigin(made);
	const checkout = await cloneAt(origin, join(folder(made, "clone"), "h"));
	const files: Record<string, string> = {
		"biome.jsonc": CONFIG,
		"package.json": packageJson(PINNED),
		".gitignore": "node_modules\n",
		[LONG_LIST]: "# Nothing waits.\n",
		[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`),
		[OLD]: LOOSE,
	};
	for (const rule of COUNT_RULES) {
		files[`${CODE_RULES}/${rule}`] = readFileSync(
			join(ROOT, CODE_RULES, rule),
			"utf8",
		);
	}
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(checkout, file)), { recursive: true });
		writeFileSync(join(checkout, file), text);
		await git(checkout, "add", file);
	}
	await git(checkout, "commit", "-q", "-m", "biome");
	await git(checkout, "push", "-q", "origin", "HEAD:main");
	const bin = join(checkout, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	symlinkSync(BIOME, join(bin, "biome"));
	symlinkSync(VITEST, join(bin, "vitest"));
	symlinkSync(
		join(ROOT, "node_modules", "vitest"),
		join(checkout, "node_modules", "vitest"),
	);
	return checkout;
}

/** Commits `files` on a branch of their own, answering the commit. */
async function change(
	checkout: string,
	files: Record<string, string>,
): Promise<string> {
	await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
	for (const [file, text] of Object.entries(files)) {
		const path = join(checkout, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
		await git(checkout, "add", file);
	}
	await git(checkout, "commit", "-q", "-m", "change");
	return git(checkout, "rev-parse", "HEAD");
}

/**
 * What the gate answers for `sha` in `checkout`, with a proven runtime
 * host-gate.sh can resolve, as on a machine that runs hosts.
 */
async function gate(
	checkout: string,
	sha: string,
): Promise<{ code: number; said: string }> {
	const env = { ...process.env, PI_HOST_RUNTIME: folder(made, "runtime") };
	try {
		const { stdout, stderr } = await run("bash", [GATE, sha], {
			cwd: checkout,
			env,
		});
		return { code: 0, said: stdout + stderr };
	} catch (error) {
		if (!isRecord(error)) throw error;
		const { code, stdout, stderr } = error;
		return {
			code: typeof code === "number" ? code : -1,
			said: `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" ? stderr : ""}`,
		};
	}
}

describe("merge-gate.sh", { timeout: GATE_TIMEOUT_MS }, () => {
	it("lets a tidy change through to host-gate", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a change Biome would format, naming the file and the fix", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/untidy.ts": "export const untidy   =   1\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/untidy.ts");
		expect(answered.said).toContain("pnpm lint:fix");
		expect(answered.said).not.toContain("host-gate:");
	});

	it("refuses a change Biome's linter faults", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/faulty.ts":
				"export function faulty(a: number): boolean {\n\treturn a == 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/faulty.ts");
	});

	it("judges only what the change touches, not a fault already on main", async () => {
		const checkout = await harness();
		writeFileSync(join(checkout, "old.ts"), "export const old   =   1\n");
		await git(checkout, "add", "old.ts");
		await git(checkout, "commit", "-q", "-m", "old");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		await git(checkout, "fetch", "-q", "origin");
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(0);
	});

	it("lets a change that only deletes a file through", async () => {
		const checkout = await harness();
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		await git(checkout, "rm", "-q", ".gitignore");
		await git(checkout, "commit", "-q", "-m", "drop");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(0);
	});

	it("refuses when the checkout has no Biome installed, naming the install", async () => {
		const checkout = await harness();
		rmSync(join(checkout, "node_modules"), { recursive: true });
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("pnpm install --frozen-lockfile");
	});

	it("refuses when the installed Biome isn't the one the head pins", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"package.json": packageJson("0.0.1"),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("0.0.1");
		expect(answered.said).toContain(PINNED);
	});

	it("refuses a change that turns a linter off, naming the file", async () => {
		const checkout = await harness();
		const sha = await change(checkout, { "scripts/loose.sh": LOOSE });

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
		expect(answered.said).toContain("main's count rules refuse");
		expect(answered.said).not.toContain("host-gate:");
	});

	it("refuses a change that lists its own new suppression", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh 1, main has 0");
		expect(answered.said).toContain("raises a list that only shrinks");
	});

	it("refuses a list whose count won't read as a number", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			[SUPPRESSION_LIST]: suppressionList(`${OLD} many`),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(
			`"${OLD} many" is not a path and a count above 0`,
		);
	});

	it("refuses a change that lists its own new long file", async () => {
		const checkout = await harness();
		const lines = Array.from(
			{ length: LONG_FILE_LINES + 1 },
			(_, n) => `export const line${n} = ${n};\n`,
		);
		const sha = await change(checkout, {
			"lib/long.ts": lines.join(""),
			[LONG_LIST]: "# Waiting.\nlib/long.ts\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/long.ts 1, main has 0");
	});

	it("reads a long-files line whole, as its rule reads it", async () => {
		// Split on spaces, "lib/my long.ts" would be a path and a count of
		// "long.ts", read as 0, and a new long file would slip through.
		const checkout = await harness();
		const lines = Array.from(
			{ length: LONG_FILE_LINES + 1 },
			(_, n) => `export const line${n} = ${n};\n`,
		);
		const sha = await change(checkout, {
			"lib/my long.ts": lines.join(""),
			[LONG_LIST]: "# Waiting.\nlib/my long.ts\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/my long.ts 1, main has 0");
	});

	it("skips an indented comment in a list, as its rule skips it", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			[SUPPRESSION_LIST]: suppressionList(
				"  # Old waits on its owner.",
				`${OLD} 1`,
			),
		});

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a suppression line with no count, as its rule refuses it", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			[SUPPRESSION_LIST]: suppressionList(OLD),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(
			`"${OLD}" is not a path and a count above 0`,
		);
	});

	it("takes a list main lacks as an empty one, once main has its rule", async () => {
		const checkout = await harness();
		await git(checkout, "rm", "-q", SUPPRESSION_LIST);
		await git(checkout, "commit", "-q", "-m", "no list");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh 1, main has 0");
	});

	it("takes the head's rule and list where main has neither yet", async () => {
		const checkout = await harness();
		const rule = `${CODE_RULES}/linters-stay-on.test.ts`;
		await git(checkout, "rm", "-q", rule, SUPPRESSION_LIST);
		await git(checkout, "commit", "-q", "-m", "no rule");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[rule]: readFileSync(join(ROOT, rule), "utf8"),
			[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
		});

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("no count that only falls has risen"),
		});
	});

	it("judges by main's file lister, not one the head emptied", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[`${CODE_RULES}/package-files.ts`]: [
				"/** Nothing, so nothing is counted. */",
				"export function packageFiles(): string[] {",
				"\treturn [];",
				"}",
				"",
				"/** Nothing is code. */",
				"export function isCode(): boolean {",
				"\treturn false;",
				"}",
				"",
				"/** No extension. */",
				"export function extensionOf(): string {",
				'\treturn "";',
				"}",
				"",
			].join("\n"),
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
	});

	it("counts a suppression under a dot folder, as code-health does", async () => {
		const checkout = await harness();
		const sha = await change(checkout, { ".tools/loose.sh": LOOSE });

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(".tools/loose.sh: 1, listed 0");
	});

	it("reads a file as its blob, whatever encoding the head's attributes ask", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			".gitattributes": "*.sh working-tree-encoding=UTF-16LE\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
	});

	it("writes main's rules inside its copy, not where a head's link points", async () => {
		// A link at a rule's own path is refused by Biome first, as the file
		// holding its target that the gate writes for it; one at the rules'
		// folder reaches the step that writes main's rules in.
		const checkout = await harness();
		const outside = folder(made, "outside");
		const rule = join(outside, "linters-stay-on.test.ts");
		writeFileSync(rule, "outside\n");
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		await git(checkout, "rm", "-q", "-r", CODE_RULES);
		mkdirSync(dirname(join(checkout, CODE_RULES)), { recursive: true });
		symlinkSync(outside, join(checkout, CODE_RULES));
		await git(checkout, "add", CODE_RULES);
		await git(checkout, "commit", "-q", "-m", "link");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(readFileSync(rule, "utf8")).toBe("outside\n");
		expect(answered.code).toBe(1);
		// Main's rules ran in the copy, and refuse a tree with no lists.
		expect(answered.said).toContain("main's count rules refuse");
		expect(answered.said).not.toContain("host-gate:");
	});

	it("refuses a head that tracks packages of its own, in any case", async () => {
		// A Mac's disk takes Node_Modules for node_modules.
		const checkout = await harness();
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		const own = join(checkout, "tests", "Node_Modules", "vitest", "index.js");
		mkdirSync(dirname(own), { recursive: true });
		writeFileSync(own, "export const it = () => {};\n");
		await git(checkout, "add", "-f", own);
		await git(checkout, "commit", "-q", "-m", "own");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("tracks files under a node_modules folder");
	});

	it("judges by main's rule, not one the head loosened", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[`${CODE_RULES}/linters-stay-on.test.ts`]:
				'import { it } from "vitest";\n\nit("passes", () => {});\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
	});

	it("sees a file the head's export-ignore would hide", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			".gitattributes": "scripts/loose.sh export-ignore\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
	});

	it("refuses a suppression fixed away while its list still waits on it", async () => {
		const checkout = await harness();
		const sha = await change(checkout, { [OLD]: "echo fixed\n" });

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(`${OLD} 0 (listed 1)`);
	});

	it("lets a suppression fixed away through once its line is off the list", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			[OLD]: "echo fixed\n",
			[SUPPRESSION_LIST]: suppressionList(),
		});

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("no count that only falls has risen"),
		});
	});

	it("refuses a long file that doesn't say why", async () => {
		const checkout = await harness();
		const lines = Array.from(
			{ length: LONG_FILE_LINES + 1 },
			(_, n) => `export const line${n} = ${n};\n`,
		);
		const sha = await change(checkout, { "lib/long.ts": lines.join("") });

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/long.ts");
		expect(answered.said).toContain("main's count rules refuse");
	});

	it("judges by main's rule a head that dropped it", async () => {
		const checkout = await harness();
		const sha = await change(checkout, { "scripts/loose.sh": LOOSE });
		await git(checkout, "rm", "-q", `${CODE_RULES}/linters-stay-on.test.ts`);
		await git(checkout, "commit", "-q", "-m", "drop");
		const dropped = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, dropped);

		expect(sha).not.toBe(dropped);
		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh: 1, listed 0");
	});

	it("refuses when the checkout has no vitest installed, naming the install", async () => {
		const checkout = await harness();
		rmSync(join(checkout, "node_modules", ".bin", "vitest"));
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("no vitest installed");
		expect(answered.said).toContain("pnpm install --frozen-lockfile");
	});
});
