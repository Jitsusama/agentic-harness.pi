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
 *
 * Long because every case drives the one gate through the same harness,
 * change and gate helpers, which hold main's rules, lists and settings,
 * and a second file would have to copy them and keep them in step.
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
import { plantParentByGraph } from "./support/commit-graph.ts";
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

/** An attributes line that merges every list as a union. */
const UNION = "*.txt merge=union\n";
/** A merge driver that keeps both sides' lines, as a union would. */
const CONCATENATE = "cat %B >> %A";

/** A global config file that merges every file as a union. */
function unionConfig(): string {
	const file = join(folder(made, "config"), "gitconfig");
	writeFileSync(file, "[merge]\n\tdefault = union\n");
	return file;
}

/**
 * A head listing a new suppression beside OLD's line, which main then takes
 * off, answering the head. Merged as a union, both lines would stand, and
 * the gate would judge a list neither side wrote rather than refuse the
 * conflict.
 */
async function listedBesideOneMainTookOff(checkout: string): Promise<string> {
	const sha = await change(checkout, {
		"scripts/new.sh": LOOSE,
		[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/new.sh 1"),
	});
	await git(checkout, "checkout", "-q", "-B", "fixed", "origin/main");
	await git(checkout, "rm", "-q", OLD);
	writeFileSync(join(checkout, SUPPRESSION_LIST), suppressionList());
	await git(checkout, "commit", "-q", "-a", "-m", "old goes");
	await git(checkout, "push", "-q", "origin", "HEAD:main");
	return sha;
}

/** Lands `files` on main, as a change merged before the head's cut. */
async function landed(
	checkout: string,
	files: Record<string, string>,
): Promise<void> {
	await change(checkout, files);
	await git(checkout, "push", "-q", "origin", "HEAD:main");
	await git(checkout, "fetch", "-q", "origin");
}

/** A GritQL plugin that faults every call to `name`, saying `message`. */
function plugin(name: string, message: string): string {
	return `language js\n\n\`${name}($_)\` as $call where {\n\tregister_diagnostic(span=$call, message="${message}")\n}\n`;
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
		await git(checkout, "add", "--", file);
	}
	await git(checkout, "commit", "-q", "-m", "change");
	return git(checkout, "rev-parse", "HEAD");
}

/**
 * A path whose git says `version` when asked, and hands everything else
 * to the git past it on the path.
 */
function gitSaying(version: string): NodeJS.ProcessEnv {
	const standIn = folder(made, "git");
	writeFileSync(
		join(standIn, "git"),
		`#!/bin/sh\nif [ "$1" = --version ]; then echo "${version}"; exit 0; fi\nPATH="\${PATH#*:}" exec git "$@"\n`,
		{ mode: 0o755 },
	);
	return { PATH: `${standIn}:${process.env.PATH ?? ""}` };
}

/**
 * What the gate answers for `sha` in `checkout`, with a proven runtime
 * host-gate.sh can resolve, as on a machine that runs hosts.
 */
async function gate(
	checkout: string,
	sha: string,
	given: NodeJS.ProcessEnv = {},
): Promise<{ code: number; said: string }> {
	const env = {
		...process.env,
		PI_HOST_RUNTIME: folder(made, "runtime"),
		...given,
	};
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

	it("refuses a change Biome would format, whatever the person's graft file says", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/untidy.ts": "export const untidy   =   1\n",
		});
		await git(checkout, "checkout", "-q", "-B", "moved", "origin/main");
		await git(checkout, "commit", "-q", "--allow-empty", "-m", "main moves");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		// One making the head the parent of main's newest commit would make
		// the head the base, so the change would seem to touch no file for
		// Biome to read.
		const main = await git(checkout, "rev-parse", "origin/main");
		const grafts = join(folder(made, "grafts"), "grafts");
		writeFileSync(grafts, `${main} ${sha}\n`);

		const answered = await gate(checkout, sha, { GIT_GRAFT_FILE: grafts });

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/untidy.ts");
	});

	it("refuses a change Biome would format, whatever the checkout's commit-graph says", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/untidy.ts": "export const untidy   =   1\n",
		});
		await git(checkout, "checkout", "-q", "-B", "moved", "origin/main");
		await git(checkout, "commit", "-q", "--allow-empty", "-m", "main moves");
		const behind = await git(checkout, "rev-parse", "HEAD");
		await git(checkout, "commit", "-q", "--allow-empty", "-m", "main moves on");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		// The gate's own repository borrows the checkout's objects, and its
		// graph with them, so one naming the head as a parent of main's
		// commit before its newest would make the head the base there too.
		const main = await git(checkout, "rev-parse", "origin/main");
		await plantParentByGraph(checkout, behind, sha);
		const planted = await git(checkout, "merge-base", `${main}^{commit}`, sha);
		expect(planted, "the graph names the head as merged").toBe(sha);

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("lib/untidy.ts");
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

	it("judges a change to Biome's own config by the config it makes", async () => {
		const checkout = await harness();
		// The config is the one file the gate checks out whatever changed, so
		// a change to it must still be checked out once, and read as the head has it.
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "space" } }\n`,
			"lib/spaced.ts": "export function spaced(): number {\n  return 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered, "the head's config judges the head").toMatchObject({
			code: 0,
		});
	});

	it("refuses a file the head's own config faults, though main's would pass it", async () => {
		const checkout = await harness();
		// Main indents with tabs, so only the head's config faults this file.
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "space" } }\n`,
			"lib/tabbed.ts": "export function tabbed(): number {\n\treturn 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("lib/tabbed.ts");
	});

	it("names the files a change to the config lets through that main's would fault", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "space" } }\n`,
			"lib/spaced.ts": "export function spaced(): number {\n  return 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said).toContain("lib/spaced.ts");
	});

	it("says nothing of loosening when the config changes and the files pass both", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "tab", "lineWidth": 100 } }\n`,
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).not.toContain("loosens a rule");
	});

	it("lets a change to the config alone through", async () => {
		const checkout = await harness();
		// No other file changes, so the list of others the gate builds is empty.
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "tab", "lineWidth": 100 } }\n`,
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("Biome passes the 1 file(s)");
		expect(answered.said).not.toContain("main's config");
	});

	it("names what a nested config the head adds lets through, judged by main's alone", async () => {
		const checkout = await harness();
		// The nested config rules lib/ alone, so only it lets these spaces
		// through; main's run must leave it out to fault them.
		const sha = await change(checkout, {
			"lib/biome.jsonc": `{ "root": false, "formatter": { "indentStyle": "space" } }\n`,
			"lib/spaced.ts": "export function spaced(): number {\n  return 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "main's run never fired").toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said, "the file it lets through").toContain(
			"lib/spaced.ts",
		);
	});

	it("names what removing a nested config of main's lets through", async () => {
		const checkout = await harness();
		await landed(checkout, {
			"lib/biome.jsonc": `{ "root": false, "formatter": { "indentStyle": "space" } }\n`,
		});
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		await git(checkout, "rm", "-q", "lib/biome.jsonc");
		const tabbed = "export function tabbed(): number {\n\treturn 1;\n}\n";
		// git rm took lib/ with its one file, so it's made again.
		mkdirSync(join(checkout, "lib"), { recursive: true });
		writeFileSync(join(checkout, "lib", "tabbed.ts"), tabbed);
		await git(checkout, "add", "lib/tabbed.ts");
		await git(checkout, "commit", "-q", "-m", "no nested config");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "main's run never fired").toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said, "the file it lets through").toContain(
			"lib/tabbed.ts",
		);
	});

	it("judges by the head's nested config, though the change leaves it be", async () => {
		const checkout = await harness();
		await landed(checkout, {
			"lib/biome.jsonc": `{ "root": false, "formatter": { "indentStyle": "space" } }\n`,
		});
		// Tabs pass the root's config, so only lib/'s own faults them.
		const sha = await change(checkout, {
			"lib/tabbed.ts": "export function tabbed(): number {\n\treturn 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "the file lib/'s config faults").toContain(
			"lib/tabbed.ts",
		);
	});

	it.each([
		["named like an option", "--spaced.ts"],
		["whose name git would quote", "lib/odd é.ts"],
	])("names a file %s on main's run", async (_, name) => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "space" } }\n`,
			[name]: "export function spaced(): number {\n  return 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "main's run judged the file").toContain(
			"main's config faults what it lets through",
		);
		expect(
			answered.said,
			"Biome couldn't judge by main's config",
		).not.toContain("couldn't judge");
	});

	it("judges main's run by main's plugin, not the head's edit of it", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		// The head's plugin, at the same path, faults another call, so only
		// main's faults alert; the config changes so main's run fires.
		const sha = await change(checkout, {
			[grit]: plugin("confirm", "no confirm"),
			"biome.jsonc": `{ "plugins": ["./${grit}"], "files": { "maxSize": 2097152 } }\n`,
			"lib/loud.ts": 'alert("hi");\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "main's plugin faulted nothing").toContain(
			"lib/loud.ts:1:1",
		);
		expect(answered.said, "main's plugin's words").toContain("no alert");
	});

	it("loads the plugins the head's config names, though the change leaves them be", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		const sha = await change(checkout, {
			"biome.jsonc": `{ "plugins": ["./${grit}"], "files": { "maxSize": 2097152 } }\n`,
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).not.toContain("Cannot read file");
		expect(answered.said).not.toContain("main's config");
	});

	it("faults the head's files by the head's own plugin, though the change leaves it be", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		const sha = await change(checkout, {
			"lib/loud.ts": 'alert("hi");\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said).toContain("no alert");
	});

	it("names a file main's own plugin faults, once the head's config stops loading it", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		// Main's plugin faults the file on a path:line:col line, so it counts
		// only if main's plugin went out beside main's config.
		const sha = await change(checkout, {
			"biome.jsonc": "{}\n",
			"lib/loud.ts": 'alert("hi");\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said).toContain("lib/loud.ts:1:1");
	});

	it("names what an edit to a plugin alone lets through, by main's plugin", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		// No config changes, so only the plugin's edit can fire main's run.
		const sha = await change(checkout, {
			[grit]: plugin("confirm", "no confirm"),
			"lib/loud.ts": 'alert("hi");\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "main's run never fired").toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said, "main's plugin's words").toContain("no alert");
	});

	it("loads plugins a root .biome.jsonc names, as Biome reads one", async () => {
		const checkout = await harness();
		const grit = "lib/no-alert.grit";
		const files = {
			[grit]: plugin("alert", "no alert"),
			".biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
			"lib/loud.ts": 'alert("hi");\n',
		};
		// Biome reads the dotted name only where no plain one is.
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		await git(checkout, "rm", "-q", "biome.jsonc");
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(dirname(join(checkout, file)), { recursive: true });
			writeFileSync(join(checkout, file), text);
			await git(checkout, "add", "--", file);
		}
		await git(checkout, "commit", "-q", "-m", "dotted config");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "the head's dotted config went unread").toContain(
			"no alert",
		);
	});

	it("judges by a nested config though TMPDIR is under a .cache folder", async () => {
		const checkout = await harness();
		await landed(checkout, {
			"lib/biome.jsonc": `{ "root": false, "formatter": { "indentStyle": "space" } }\n`,
		});
		const sha = await change(checkout, {
			"lib/tabbed.ts": "export function tabbed(): number {\n\treturn 1;\n}\n",
		});
		// Biome reads no nested config under a .cache folder, as a pi
		// session's TMPDIR is.
		const cached = join(folder(made, "home"), ".cache", "tmp");
		mkdirSync(cached, { recursive: true });

		const answered = await gate(checkout, sha, { TMPDIR: cached });

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "the file lib/'s config faults").toContain(
			"lib/tabbed.ts",
		);
	});

	it("refuses where Biome fails in the probe without faulting its files", async () => {
		const checkout = await harness();
		// A Biome that processes nothing in the probe's copy, as one ignoring
		// every file there would, and judges the real copy as it should.
		const stand = join(checkout, "node_modules", ".bin", "biome");
		rmSync(stand);
		writeFileSync(
			stand,
			`#!/bin/sh\ncase $PWD in */probe) echo "No files were processed."; exit 1;; esac\nexec "${BIOME}" "$@"\n`,
			{ mode: 0o755 },
		);
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "the probe took a failing run for a fault").toContain(
			"judges no file by its nested config",
		);
	});

	it("loads a plugin whose name git would quote", async () => {
		const checkout = await harness();
		const grit = "lib/no alert é.grit";
		await landed(checkout, {
			[grit]: plugin("alert", "no alert"),
			"biome.jsonc": `{ "plugins": ["./${grit}"] }\n`,
		});
		const sha = await change(checkout, {
			"biome.jsonc": "{}\n",
			"lib/loud.ts": 'alert("hi");\n',
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).not.toContain("Cannot read file");
		expect(answered.said).toContain("lib/loud.ts:1:1");
	});

	it("judges a changed file whose name git would quote", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/odd é.ts": "export const odd = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said, "the file wasn't judged").toContain(
			"Biome passes the 1 file(s)",
		);
	});

	it("reads a changed file named like an option as a file", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"--write.ts": "export const written=2\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "Biome didn't fault the file").toContain(
			"Formatter would have printed the following content",
		);
	});

	it("names a file by main's config as it is now, not as it was at the cut", async () => {
		const checkout = await harness();
		// A config of several lines, so main's edit at the top and the head's
		// at the bottom merge cleanly, as edits to a real config do.
		const config = (indent: string, size: number) =>
			`{\n\t"formatter": {\n\t\t"indentStyle": "${indent}"\n\t},\n\t"linter": {\n\t\t"enabled": true\n\t},\n\t"files": {\n\t\t"maxSize": ${size}\n\t}\n}\n`;
		writeFileSync(join(checkout, "biome.jsonc"), config("tab", 1048576));
		await git(checkout, "commit", "-q", "-a", "-m", "long config");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		const sha = await change(checkout, {
			"biome.jsonc": config("tab", 2097152),
			"lib/tabbed.ts": "export function tabbed(): number {\n\treturn 1;\n}\n",
		});
		// Main moves to spaces after the cut, so only its config as it is now
		// faults the head's tabs; the merge-base's still indents with tabs.
		await git(checkout, "checkout", "-q", "-B", "spaced", "origin/main");
		writeFileSync(join(checkout, "biome.jsonc"), config("space", 1048576));
		await git(checkout, "commit", "-q", "-a", "-m", "spaces");
		await git(checkout, "push", "-q", "origin", "HEAD:main");

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain(
			"main's config faults what it lets through",
		);
		expect(answered.said).toContain("main tightened one since the cut");
		expect(answered.said).toContain("lib/tabbed.ts");
	});

	it("says nothing of loosening when main has no config to compare", async () => {
		const checkout = await harness();
		await git(checkout, "rm", "-q", "biome.jsonc");
		await git(checkout, "commit", "-q", "-m", "no config");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		const sha = await change(checkout, {
			"biome.jsonc": `{ "formatter": { "indentStyle": "space" } }\n`,
			"lib/spaced.ts": "export function spaced(): number {\n  return 1;\n}\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).not.toContain("main's config");
	});

	it("says it couldn't judge, not that a rule loosened, when main's config won't load", async () => {
		const checkout = await harness();
		writeFileSync(
			join(checkout, "biome.jsonc"),
			`{ "formatter": { "indentStyle": "sideways" } }\n`,
		);
		await git(checkout, "commit", "-q", "-a", "-m", "broken config");
		await git(checkout, "push", "-q", "origin", "HEAD:main");
		const sha = await change(checkout, {
			"biome.jsonc": CONFIG,
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain(
			"couldn't judge its files by main's config",
		);
		expect(answered.said).not.toContain("loosens a rule");
	});

	it("doesn't take a changed path quoted in main's config error for a fault", async () => {
		const checkout = await harness();
		// The bad value sits on the line that names the file, so Biome's frame
		// around the config error quotes the path, indented, as text.
		await landed(checkout, {
			"biome.jsonc": `{ "files": { "includes": ["lib/tidy.ts"], "maxSize": "big" } }\n`,
		});
		const sha = await change(checkout, {
			"biome.jsonc": CONFIG,
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(0);
		expect(answered.said).toContain("lib/tidy.ts");
		expect(answered.said).toContain(
			"couldn't judge its files by main's config",
		);
		expect(answered.said).not.toContain("loosens a rule");
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

	it("judges by main's own list, whatever the checkout replaces it with", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
		});
		const mains = await git(
			checkout,
			"rev-parse",
			`origin/main:${SUPPRESSION_LIST}`,
		);
		const heads = await git(
			checkout,
			"rev-parse",
			`${sha}:${SUPPRESSION_LIST}`,
		);
		await git(checkout, "replace", mains, heads);

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("raises a list that only shrinks");
	});

	// A tag or a local branch outranks a remote's branch of the same short
	// name, so main would be the head itself, and its list the head's.
	it.each([
		["tag", "refs/tags/origin/main"],
		["local branch", "refs/heads/origin/main"],
	])(
		"judges against origin's main, whatever %s the checkout names origin/main",
		async (_, ref) => {
			const checkout = await harness();
			const sha = await change(checkout, {
				"scripts/loose.sh": LOOSE,
				[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
			});
			await git(checkout, "update-ref", ref, sha);

			const answered = await gate(checkout, sha);

			expect(answered.code).toBe(1);
			expect(answered.said).toContain("scripts/loose.sh 1, main has 0");
		},
	);

	it("judges against main as origin has it, whatever the checkout's refspec fetches", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[SUPPRESSION_LIST]: suppressionList(`${OLD} 1`, "scripts/loose.sh 1"),
		});
		// Fetching main by the checkout's refspec then leaves its origin/main
		// where it was, here the head itself, whose list would judge its own.
		await git(
			checkout,
			"config",
			"remote.origin.fetch",
			"+refs/heads/none:refs/remotes/origin/none",
		);
		await git(checkout, "update-ref", "refs/remotes/origin/main", sha);

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh 1, main has 0");
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

	it("lets a head through whose base listed a line main has since taken off", async () => {
		// On 24 November #2114 took a line off a list that only shrinks, and
		// the gate refused four heads cut before it that still carried the
		// line. Here main takes OLD's line off the suppression list.
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});
		await git(checkout, "checkout", "-q", "-B", "fixed", "origin/main");
		await git(checkout, "rm", "-q", OLD);
		writeFileSync(join(checkout, SUPPRESSION_LIST), suppressionList());
		await git(checkout, "commit", "-q", "-a", "-m", "old goes");
		await git(checkout, "push", "-q", "origin", "HEAD:main");

		const answered = await gate(checkout, sha);

		expect(answered).toMatchObject({
			code: 0,
			said: expect.stringContaining("touches nothing pi hosts run"),
		});
	});

	it("refuses a head that doesn't merge cleanly with main, naming the rebase", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			[OLD]: `${LOOSE}echo again\n`,
		});
		await git(checkout, "checkout", "-q", "-B", "fixed", "origin/main");
		await git(checkout, "rm", "-q", OLD);
		writeFileSync(join(checkout, SUPPRESSION_LIST), suppressionList());
		await git(checkout, "commit", "-q", "-a", "-m", "old goes");
		await git(checkout, "push", "-q", "origin", "HEAD:main");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
		expect(answered.said).toContain("Rebase the branch on origin/main");
		expect(answered.said.split("\n")).toContain(OLD);
	});

	it("merges a list as git does by default, whatever the checkout's attributes say", async () => {
		const checkout = await harness();
		const sha = await listedBesideOneMainTookOff(checkout);
		writeFileSync(join(checkout, ".gitattributes"), UNION);

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
		expect(answered.said).toContain(SUPPRESSION_LIST);
	});

	it("merges a list as git does by default, whatever the person's attributes file says", async () => {
		const checkout = await harness();
		const sha = await listedBesideOneMainTookOff(checkout);
		// Where git reads a person's attributes when no config names a file.
		const home = folder(made, "config");
		mkdirSync(join(home, "git"));
		writeFileSync(join(home, "git", "attributes"), UNION);

		const answered = await gate(checkout, sha, { XDG_CONFIG_HOME: home });

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
	});

	it("merges a list as git does by default, whatever the checkout's merge.default says", async () => {
		const checkout = await harness();
		const sha = await listedBesideOneMainTookOff(checkout);
		await git(checkout, "config", "merge.default", "union");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
	});

	it("merges a list as git does by default, whatever driver the checkout's config sets", async () => {
		const checkout = await harness();
		const sha = await listedBesideOneMainTookOff(checkout);
		await git(checkout, "config", "merge.both.driver", CONCATENATE);
		await git(checkout, "config", "merge.default", "both");

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
	});

	it.each<
		[string, (checkout: string, sha: string) => Promise<Record<string, string>>]
	>([
		[
			"named global config file",
			async () => ({ GIT_CONFIG_GLOBAL: unionConfig() }),
		],
		[
			// Where git reads a person's config when nothing names a file.
			"global config file",
			async () => {
				const home = folder(made, "home");
				writeFileSync(join(home, ".gitconfig"), "[merge]\n\tdefault = union\n");
				return { HOME: home };
			},
		],
		[
			"config in the environment",
			async () => ({
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "merge.default",
				GIT_CONFIG_VALUE_0: "union",
			}),
		],
		[
			// A graft making main the head's parent would leave nothing to
			// merge, so the head's list would land whole.
			"graft file",
			async (checkout, sha) => {
				const main = await git(checkout, "rev-parse", "origin/main");
				const grafts = join(folder(made, "grafts"), "grafts");
				writeFileSync(grafts, `${sha} ${main}\n`);
				return { GIT_GRAFT_FILE: grafts };
			},
		],
	])(
		"merges a list as git does by default, whatever the person's %s says",
		async (_, given) => {
			const checkout = await harness();
			const sha = await listedBesideOneMainTookOff(checkout);

			const answered = await gate(checkout, sha, await given(checkout, sha));

			expect(answered.code).toBe(1);
			expect(answered.said).toContain("doesn't merge cleanly with main");
		},
	);

	it("merges a list as git does by default, whatever the checkout's own attributes file says", async () => {
		const checkout = await harness();
		const sha = await listedBesideOneMainTookOff(checkout);
		const info = join(checkout, ".git", "info", "attributes");
		mkdirSync(dirname(info), { recursive: true });
		writeFileSync(info, UNION);

		const answered = await gate(checkout, sha);

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("doesn't merge cleanly with main");
	});

	it.each([
		["git version 2.41.0", "which needs git 2.42"],
		["git version 1.99.0", "which needs git 2.42"],
		["git version 2.4a.1", "which needs git 2.42"],
		["git version foo.bar", "can't read which git this is"],
	])("refuses to judge with a git that says %s", async (version, why) => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"lib/tidy.ts": "export const tidy = 1;\n",
		});

		const answered = await gate(checkout, sha, gitSaying(version));

		expect(answered.code).toBe(1);
		expect(answered.said).toContain(why);
		expect(answered.said).toContain(version);
	});

	it.each(["git version 2.42.0", "git version 3.0.0"])(
		"judges with a git that says %s",
		async (version) => {
			const checkout = await harness();
			const sha = await change(checkout, {
				"lib/tidy.ts": "export const tidy = 1;\n",
			});

			const answered = await gate(checkout, sha, gitSaying(version));

			expect(answered.said).toContain("touches nothing pi hosts run");
			expect(answered.code).toBe(0);
		},
	);

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

	it("refuses packages of its own at the root, whose name git would quote", async () => {
		const checkout = await harness();
		await git(checkout, "checkout", "-q", "-B", "work", "origin/main");
		// Not a file Biome reads, so only the sweep can see it.
		const own = join(checkout, "node_modules", "é", "README.md");
		mkdirSync(dirname(own), { recursive: true });
		writeFileSync(own, "# Mine\n");
		await git(checkout, "add", "-f", own);
		await git(checkout, "commit", "-q", "-m", "own");
		const sha = await git(checkout, "rev-parse", "HEAD");

		const answered = await gate(checkout, sha);

		expect(answered.code, answered.said).toBe(1);
		expect(answered.said, "the packages weren't seen").toContain(
			"tracks files under a node_modules folder",
		);
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

	it("counts every file the head holds, whatever git folder the gate is given", async () => {
		const checkout = await harness();
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			".gitignore": "node_modules/\nscripts/loose.sh\n",
		});
		// The checkout's index is main's, so only the head's .gitignore would
		// speak for its new file, were the rules' git given this folder.
		await git(checkout, "checkout", "-q", "--detach", "origin/main");

		const answered = await gate(checkout, sha, {
			GIT_DIR: join(checkout, ".git"),
		});

		expect(answered.code).toBe(1);
		expect(answered.said).toContain("scripts/loose.sh");
	});

	it("judges by main's rule, whatever the checkout replaces it with", async () => {
		const checkout = await harness();
		const rule = `${CODE_RULES}/linters-stay-on.test.ts`;
		const sha = await change(checkout, {
			"scripts/loose.sh": LOOSE,
			[rule]: 'import { it } from "vitest";\n\nit("passes", () => {});\n',
		});
		const mains = await git(checkout, "rev-parse", `origin/main:${rule}`);
		const heads = await git(checkout, "rev-parse", `${sha}:${rule}`);
		await git(checkout, "replace", mains, heads);

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
