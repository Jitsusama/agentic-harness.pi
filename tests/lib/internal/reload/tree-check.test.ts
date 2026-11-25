/**
 * Putting a tree through its typecheck and the tests its changes reach
 * before a reload: reading what tsc and vitest say, stopping at the
 * first check that fails, and running stand-ins for both through the
 * same pipes.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkTree,
	describeTree,
	MOST_NAMED,
	type Ran,
	type Runner,
	runCommand,
	testReport,
	typeErrors,
} from "../../../../lib/internal/reload/tree-check.ts";

let tree: string;

beforeEach(() => {
	tree = mkdtempSync(join(tmpdir(), "tree-check-"));
});

afterEach(() => {
	rmSync(tree, { recursive: true, force: true });
});

/** Put a program in the tree's node_modules/.bin, saying `body` as sh. */
function install(name: string, body = "exit 0"): void {
	const bin = join(tree, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(bin, name), 0o755);
}

/** vitest's JSON report, holding the files given. */
function vitestJson(files: readonly object[], passed: number): string {
	return JSON.stringify({ numPassedTests: passed, testResults: files });
}

/** The file vitest writes its report to, from the arguments it was given. */
function outputFile(args: readonly string[]): string {
	const flag = args.find((arg) => arg.startsWith("--outputFile="));
	if (flag === undefined) throw new Error("vitest was given no output file");
	return flag.slice("--outputFile=".length);
}

/** A runner whose tsc and vitest end as told, recording what ran. */
function standIn(
	tsc: Partial<Ran>,
	vitest: Partial<Ran> & { report?: string } = {},
): { run: Runner; ran: string[][] } {
	const ran: string[][] = [];
	const run: Runner = (command, args) => {
		ran.push([command, ...args]);
		const end = { code: 0, stdout: "", stderr: "", hung: false };
		if (command.endsWith("tsc")) return Promise.resolve({ ...end, ...tsc });
		if (vitest.report !== undefined) {
			writeFileSync(outputFile(args), vitest.report);
		}
		return Promise.resolve({ ...end, ...vitest });
	};
	return { run, ran };
}

describe("reading what the checks said", () => {
	it("names each type error by file, line and code", () => {
		expect(
			typeErrors(
				[
					"lib/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
					"  The expected type comes from property 'n'",
					"tests/b.test.ts(3,1): error TS2304: Cannot find name 'x'.",
				].join("\n"),
			),
		).toEqual([
			"lib/a.ts:12: TS2322 Type 'string' is not assignable to type 'number'.",
			"tests/b.test.ts:3: TS2304 Cannot find name 'x'.",
		]);
	});

	it("names each failing test with its first cause, and a file that failed with none", () => {
		const report = vitestJson(
			[
				{
					name: join(tree, "tests/a.test.ts"),
					status: "failed",
					message: "",
					assertionResults: [
						{ fullName: "a works", status: "passed", failureMessages: [] },
						{
							fullName: "a refuses b",
							status: "failed",
							failureMessages: [
								"\nAssertionError: expected 1 to be 2\n    at a.test.ts:9",
							],
						},
					],
				},
				{
					name: join(tree, "tests/c.test.ts"),
					status: "failed",
					message: "Cannot find module './gone.ts'\nRequire stack:",
					assertionResults: [],
				},
			],
			1,
		);
		expect(testReport(report, tree)).toEqual({
			failures: [
				"tests/a.test.ts > a refuses b: AssertionError: expected 1 to be 2",
				"tests/c.test.ts: Cannot find module './gone.ts'",
			],
			passed: 1,
		});
	});

	it("reads nothing from a report cut short", () => {
		expect(testReport('{"numPassedTests":', tree)).toBeUndefined();
		expect(testReport("{}", tree)).toBeUndefined();
	});
});

describe("putting a tree through its checks", () => {
	it("passes a tree whose typecheck and changed tests pass, running them in that order in the tree", async () => {
		install("tsc");
		install("vitest");
		const { run, ran } = standIn({}, { report: vitestJson([], 7) });
		const steps: string[] = [];
		const report = await checkTree(tree, {
			run,
			onStep: (step) => steps.push(step),
		});
		expect(report.ok).toBe(true);
		expect(steps).toEqual(["typecheck", "tests"]);
		expect(ran.map(([command]) => command)).toEqual([
			join(tree, "node_modules/.bin/tsc"),
			join(tree, "node_modules/.bin/vitest"),
		]);
		expect(ran[1]).toEqual(
			expect.arrayContaining(["--changed", "origin/main", "--passWithNoTests"]),
		);
		expect(describeTree(report, "~/t")).toBe(
			"~/t passes its typecheck and the 7 tests its changes reach.",
		);
	});

	it("stops at a failing typecheck, naming its errors, before any test runs", async () => {
		install("tsc");
		install("vitest");
		const { run, ran } = standIn({
			code: 2,
			stdout: "lib/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
		});
		const report = await checkTree(tree, { run });
		expect(report.ok).toBe(false);
		expect(ran).toHaveLength(1);
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed:\n- lib/a.ts:1: TS2304 Cannot find name 'x'.",
		);
	});

	it("refuses a tree whose changed tests fail, naming each", async () => {
		install("tsc");
		install("vitest");
		const failing = Array.from({ length: MOST_NAMED + 2 }, (_, n) => ({
			fullName: `case ${n}`,
			status: "failed",
			failureMessages: ["Error: no"],
		}));
		const { run } = standIn(
			{},
			{
				code: 1,
				report: vitestJson(
					[
						{
							name: join(tree, "tests/x.test.ts"),
							status: "failed",
							assertionResults: failing,
						},
					],
					3,
				),
			},
		);
		const said = describeTree(await checkTree(tree, { run }), "~/t");
		expect(said).toContain(
			"The tests its changes reach (vitest --changed origin/main) failed:",
		);
		expect(said).toContain("- tests/x.test.ts > case 0: Error: no");
		expect(said).not.toContain(`case ${MOST_NAMED}:`);
		expect(said).toContain("- and 2 more");
	});

	it("can't pass a tree whose tests ended without a report, or failed with none named", async () => {
		install("tsc");
		install("vitest");
		const silent = standIn({}, { code: 1, stderr: "Error: config broke\n" });
		expect(describeTree(await checkTree(tree, silent), "~/t")).toContain(
			"failed: it exited with 1: Error: config broke.",
		);
		const unnamed = standIn({}, { code: 1, report: vitestJson([], 4) });
		expect((await checkTree(tree, unnamed)).ok).toBe(false);
	});

	it("can't pass a tree with no programs to check it with", async () => {
		const report = await checkTree(tree, { run: standIn({}).run });
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed: it has no node_modules/.bin/tsc, so install or link its node_modules.",
		);
		install("tsc");
		expect(
			describeTree(await checkTree(tree, { run: standIn({}).run }), "~/t"),
		).toContain("it has no node_modules/.bin/vitest");
	});

	it("runs stand-in programs for real: the report file, a failing exit and a hang", async () => {
		install(
			"tsc",
			"echo \"lib/a.ts(2,3): error TS1005: ';' expected.\"\nexit 2",
		);
		const failed = await checkTree(tree);
		expect(failed.steps[0]?.failures).toEqual([
			"lib/a.ts:2: TS1005 ';' expected.",
		]);

		install("tsc");
		install(
			"vitest",
			[
				'for arg; do case $arg in --outputFile=*) out=$(echo "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${vitestJson([], 2)}' > "$out"`,
			].join("\n"),
		);
		expect(await checkTree(tree)).toMatchObject({ ok: true });

		// Long enough to outlast the half-second budget below, so the run is
		// cut off; exec'd, so the kill reaches the sleeper holding the pipes.
		install("vitest", "exec sleep 5");
		const hung = await checkTree(tree, { run: runCommand, timeoutMs: 500 });
		expect(describeTree(hung, "~/t")).toContain(
			"it was still running after 1s",
		);
	});
});
