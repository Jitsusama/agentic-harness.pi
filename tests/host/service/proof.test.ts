/**
 * A runtime's proof: read from the file a unit names, held to the pi it
 * runs, and judged from the run that wrote it.
 */

import {
	mkdirSync,
	mkdtempSync,
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
	PROOF_KIND,
	PROOF_VERSION,
	parseProof,
	proofRefusal,
	provenBy,
	type RunSummary,
	runtimeOf,
} from "../../../host/service/proof.ts";

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
