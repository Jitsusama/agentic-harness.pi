/**
 * A runtime's proof: read from the file a unit names, held to the pi it
 * runs, and judged from the run that wrote it.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HostProof,
	hostProof,
	judgedLog,
	judgedReport,
	PROOF_KIND,
	PROOF_VERSION,
	parseProof,
	proofRefusal,
	provenBy,
	REPORT_ENDS,
	REPORT_FOLLOWS,
	type RunSummary,
	runtimeOf,
} from "../../../host/service/proof.ts";
// Imported only to be named, so `--changed` runs this file when a script
// it runs or reads changes alone; it reads them from their paths below.
import "../../../scripts/host-run.sh";
import "../../../scripts/host-test-there.sh";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "host-proof-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A runtime folder with its pi-monorepo, and the pi's path. */
function runtimeAt(name: string): { runtime: string; pi: string } {
	const runtime = join(dir, name);
	const pi = join(runtime, "lib", "node_modules", "pi-monorepo");
	mkdirSync(pi, { recursive: true });
	return { runtime, pi };
}

function proofFor(runtime: string): HostProof {
	return {
		kind: PROOF_KIND,
		version: PROOF_VERSION,
		runtime,
		harness: "8bd554ed03f8",
		files: 14,
		cases: 71,
		provenAt: "2026-11-10T11:00:00.000Z",
	};
}

const passed: RunSummary = {
	success: true,
	numTotalTests: 71,
	numPassedTests: 71,
	numFailedTests: 0,
	numPendingTests: 0,
	numTodoTests: 0,
	testResults: Array.from({ length: 14 }, () => ({})),
};

describe("a runtime's proof", () => {
	it("reads back what was written", () => {
		const proof = proofFor("/nix/store/abc-pi-host-runtime-1.5.0");
		expect(parseProof(JSON.stringify(proof))).toEqual(proof);
	});

	it("refuses what isn't a proof, saying what's wrong", () => {
		const proof = proofFor("/nix/store/abc-pi-host-runtime-1.5.0");
		const cases: [string, string][] = [
			["not json", "isn't JSON"],
			[JSON.stringify({ ...proof, kind: "other" }), `isn't a ${PROOF_KIND}`],
			[JSON.stringify({ ...proof, version: 2 }), "is version 2"],
			[JSON.stringify({ ...proof, runtime: "relative" }), "lacks its runtime"],
			[JSON.stringify({ ...proof, cases: "71" }), "lacks its runtime"],
		];
		for (const [text, said] of cases)
			expect(() => parseProof(text)).toThrow(said);
	});

	it("proves the pi inside its runtime, through a link to it too", () => {
		const { runtime, pi } = runtimeAt("proven");
		const link = join(dir, "link");
		symlinkSync(runtime, link);
		expect(proofRefusal(proofFor(runtime), pi)).toBeUndefined();
		expect(proofRefusal(proofFor(link), pi)).toBeUndefined();
		expect(
			proofRefusal(
				proofFor(runtime),
				join(link, "lib", "node_modules", "pi-monorepo"),
			),
		).toBeUndefined();
	});

	it("proves a pi not there yet through the links above it, leaving its loader to refuse it", () => {
		const runtime = join(dir, "empty");
		mkdirSync(runtime);
		const link = join(dir, "link");
		symlinkSync(runtime, link);
		expect(proofRefusal(proofFor(runtime), join(link, "pi"))).toBeUndefined();
		expect(proofRefusal(proofFor(link), join(runtime, "pi"))).toBeUndefined();
	});

	it("refuses a pi in another runtime, even one whose name starts the same", () => {
		const proven = runtimeAt("runtime");
		const other = runtimeAt("runtime-next");
		expect(proofRefusal(proofFor(proven.runtime), other.pi)).toContain(
			`is for ${proven.runtime}, not the pi at ${other.pi}`,
		);
	});

	it("names a store pi's runtime for the command to prove it", () => {
		expect(
			runtimeOf(
				"/nix/store/abc-pi-host-runtime-1.5.0/lib/node_modules/pi-monorepo",
			),
		).toBe("/nix/store/abc-pi-host-runtime-1.5.0");
	});
});

describe("a unit's proof", () => {
	it("is read from PI_HOST_PROOF and held to the host's pi", () => {
		const { runtime, pi } = runtimeAt("proven");
		const file = join(dir, "proof.json");
		writeFileSync(file, JSON.stringify(proofFor(runtime)));
		expect(hostProof({ PI_HOST_PROOF: file }, pi).runtime).toBe(runtime);

		const other = runtimeAt("other");
		expect(() => hostProof({ PI_HOST_PROOF: file }, other.pi)).toThrow(
			"prove that pi with node scripts/host-prove.ts",
		);
	});

	it("is refused when the unit names none, or one that can't be read", () => {
		const { pi } = runtimeAt("unproven");
		expect(() => hostProof({}, pi)).toThrow(
			"PI_HOST_PROOF must name the proof",
		);
		expect(() => hostProof({ PI_HOST_PROOF: "proof.json" }, pi)).toThrow(
			"PI_HOST_PROOF must name the proof",
		);
		expect(() =>
			hostProof({ PI_HOST_PROOF: join(dir, "missing.json") }, pi),
		).toThrow("which can't be read");
	});
});

describe("what a run proves", () => {
	it("counts the files and cases of a run in which every case passed", () => {
		expect(provenBy(passed)).toEqual({ files: 14, cases: 71 });
	});

	it("proves nothing when any case failed or skipped, or none ran", () => {
		const cases: [Partial<RunSummary>, string][] = [
			[{ numFailedTests: 2, numPassedTests: 69 }, "2 of 71 cases failed"],
			[{ numPendingTests: 3, numPassedTests: 68 }, "3 of 71 cases skipped"],
			[{ numTodoTests: 1, numPassedTests: 70 }, "1 of 71 cases skipped"],
			[{ success: false }, "the run failed outside any case"],
			[{ numTotalTests: 0, numPassedTests: 0 }, "no case ran"],
		];
		for (const [change, said] of cases)
			expect(provenBy({ ...passed, ...change })).toBe(said);
	});
});

describe("a lent run's log", () => {
	const COMMIT = "1d7d61247a65f01e7b774a00faec0a4ae70d7b23";
	const RUNTIME =
		"/nix/store/52jr2rxrgkgl47wa7ymz93ff5ximyn8z-pi-host-runtime-1.5.0";
	const report = JSON.stringify(passed);

	const SCRIPTS = join(import.meta.dirname, "../../../scripts");
	const STARTS = `host-test-there: test:host at ${COMMIT} on ${RUNTIME}`;
	const ENDS = (exit: number) => `${STARTS} exited ${exit}`;

	/** A log as host-test-there saves one, from its lines in order. */
	function log({
		starts = STARTS,
		ends = ENDS(0),
		between = report,
	}: {
		starts?: string;
		ends?: string;
		between?: string;
	} = {}): string {
		return [
			"host-send-runtime: nix-offload already holds what it needs",
			starts,
			" ✓ tests/host/engine/engine.test.ts (34 tests)",
			REPORT_FOLLOWS,
			between,
			"",
			REPORT_ENDS,
			ends,
			"rc=0",
		].join("\n");
	}

	it("proves what the report host-run printed proves, carriage returns or not", () => {
		expect(judgedLog(log(), COMMIT, RUNTIME)).toEqual({ files: 14, cases: 71 });
		expect(judgedLog(log().replaceAll("\n", "\r\n"), COMMIT, RUNTIME)).toEqual({
			files: 14,
			cases: 71,
		});
	});

	it("proves nothing when the run exited other than 0", () => {
		expect(judgedLog(log({ ends: ENDS(1) }), COMMIT, RUNTIME)).toBe(
			"the run exited 1",
		);
	});

	it("proves nothing of another commit or runtime than the log's", () => {
		const other = "0".repeat(40);
		expect(judgedLog(log(), other, RUNTIME)).toBe(
			`the log ran ${COMMIT}, not ${other}`,
		);
		expect(judgedLog(log(), COMMIT, "/nix/store/other")).toBe(
			`the log ran on ${RUNTIME}, not /nix/store/other`,
		);
		const endsElsewhere = ENDS(0).replace(RUNTIME, "/nix/store/other");
		expect(judgedLog(log({ ends: endsElsewhere }), COMMIT, RUNTIME)).toBe(
			`the log ran on /nix/store/other, not ${RUNTIME}`,
		);
	});

	it("proves nothing from a log host-test-there didn't start and end", () => {
		const bare = [REPORT_FOLLOWS, report, REPORT_ENDS].join("\n");
		expect(judgedLog(bare, COMMIT, RUNTIME)).toBe(
			"the log holds no start and end lines from host-test-there",
		);
		expect(judgedLog(log({ ends: "" }), COMMIT, RUNTIME)).toBe(
			"the log holds no start and end lines from host-test-there",
		);
	});

	it("proves nothing from a log holding two runs", () => {
		const failed = JSON.stringify({ ...passed, numFailedTests: 1 });
		const twice = `${log({ between: failed, ends: ENDS(1) })}\n${log()}`;
		expect(judgedLog(twice, COMMIT, RUNTIME)).toBe(
			"the log holds more than one run",
		);
	});

	it("proves nothing without a whole report inside the run", () => {
		const cut = log()
			.split("\n")
			.filter((line) => line !== REPORT_ENDS)
			.join("\n");
		const backwards = log()
			.replace(REPORT_FOLLOWS, "MARK")
			.replace(REPORT_ENDS, REPORT_FOLLOWS)
			.replace("MARK", REPORT_ENDS);
		for (const text of [cut, backwards])
			expect(judgedLog(text, COMMIT, RUNTIME)).toBe(
				"the log holds no whole report inside its run",
			);
	});

	it("says why a report proves nothing", () => {
		expect(judgedLog(log({ between: "{cut" }), COMMIT, RUNTIME)).toBe(
			"the run's report isn't JSON",
		);
		expect(judgedReport("{}")).toBe("the run's report isn't vitest's");
		expect(judgedReport(JSON.stringify({ ...passed, numFailedTests: 2 }))).toBe(
			"2 of 71 cases failed",
		);
	});

	it("reads host-test-there.sh's own start and end lines", () => {
		const script = readFileSync(join(SCRIPTS, "host-test-there.sh"), "utf8");
		const said = [
			...script.matchAll(/echo "(host-test-there: test:host at [^"]*)"/g),
		].map(([, line = ""]) =>
			line
				.replace("$rev", COMMIT)
				.replace("$runtime", RUNTIME)
				.replace("$status", "0"),
		);
		expect(said).toEqual([STARTS, ENDS(0)]);
	});

	it("is printed by host-run.sh after the suite, keeping the suite's exit", () => {
		// A stand-in pnpm: installs nothing, and runs a suite that writes
		// its report where vitest is told to and exits 3.
		const tools = join(dir, "tools");
		mkdirSync(tools);
		const pnpm = join(tools, "pnpm");
		writeFileSync(
			pnpm,
			[
				"#!/usr/bin/env bash",
				"[[ $1 == install ]] && exit 0",
				'for word in "$@"; do',
				`  [[ $word == --outputFile.json=* ]] && printf %s "$REPORT" > "\${word#*=}"`,
				"done",
				"echo suite ran",
				"exit 3",
			].join("\n"),
		);
		chmodSync(pnpm, 0o755);
		const ran = spawnSync(
			"bash",
			[join(SCRIPTS, "host-run.sh"), RUNTIME, "/nix/store/mycelium", tools],
			{
				encoding: "utf8",
				env: { ...process.env, HOST_RUN_INSIDE: "1", REPORT: report },
			},
		);
		expect(ran.status, ran.stderr).toBe(3);
		expect(ran.stdout).toBe(
			["suite ran", REPORT_FOLLOWS, report, REPORT_ENDS, ""].join("\n"),
		);
	});
});
