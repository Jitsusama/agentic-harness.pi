/**
 * The host gate's reporter, on the cases a run ended with: it names each
 * that skipped, with its note, and nothing that passed or failed, letting
 * by only a case another platform alone runs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestModule } from "vitest/node";
import EveryCaseRan, { skipsIn } from "./every-case-ran.mts";
import { onlyOnNote, onlyOnPlatform } from "./only-on.mts";

/** A file whose cases ended as given. */
function file(
	moduleId: string,
	cases: readonly { name: string; state: string; note?: string }[],
) {
	return {
		moduleId,
		children: {
			*allTests() {
				for (const { name, state, note } of cases)
					yield {
						fullName: name,
						result: () => (note === undefined ? { state } : { state, note }),
					};
			},
		},
	};
}

describe("skipsIn", () => {
	it("names each skipped case with its file and its note", () => {
		expect(
			skipsIn([
				file("engine.test.ts", [
					{ name: "opens", state: "passed" },
					{ name: "resumes", state: "skipped", note: "No pi built" },
				]),
				file("screens.test.ts", [{ name: "hands off", state: "skipped" }]),
			]).refused,
		).toEqual([
			"engine.test.ts: resumes: No pi built",
			"screens.test.ts: hands off: skipped, saying nothing of why",
		]);
	});

	it("names a file from the root it is given", () => {
		expect(
			skipsIn(
				[
					file("/repo/tests/host/parity/parity.test.ts", [
						{ name: "tool", state: "skipped", note: "No pi built" },
					]),
				],
				"/repo",
			).refused,
		).toEqual(["tests/host/parity/parity.test.ts: tool: No pi built"]);
	});

	it("finds nothing when every case ran", () => {
		expect(
			skipsIn([
				file("parity.test.ts", [
					{ name: "tool", state: "passed" },
					{ name: "abort", state: "failed" },
				]),
			]),
		).toEqual({ refused: [], elsewhere: [] });
	});

	it("lets by a case only another platform runs, and refuses it on that platform", () => {
		const linuxOnly = onlyOnNote("linux", "it reads /proc");
		const ran = [
			file("held-logs.test.ts", [
				{ name: "holds a log once", state: "skipped", note: linuxOnly },
			]),
		];
		const line = `held-logs.test.ts: holds a log once: ${linuxOnly}`;
		expect(skipsIn(ran, "", "darwin"), "on the Mac").toEqual({
			refused: [],
			elsewhere: [line],
		});
		expect(skipsIn(ran, "", "linux"), "on Linux itself").toEqual({
			refused: [line],
			elsewhere: [],
		});
	});

	it("refuses a note that names a platform only past its start", () => {
		const ran = [
			file("engine.test.ts", [
				{
					name: "resumes",
					state: "skipped",
					note: `No pi built; ${onlyOnNote("linux", "it reads /proc")}`,
				},
			]),
		];
		expect(skipsIn(ran, "", "darwin").elsewhere).toEqual([]);
	});
});

describe("the reporter", () => {
	const exitCode = process.exitCode;
	afterEach(() => {
		process.exitCode = exitCode;
		vi.restoreAllMocks();
	});

	/** The exit code and what it said, after a run that ended with `ran`. */
	function report(ran: readonly ReturnType<typeof file>[]) {
		const said: string[] = [];
		vi.spyOn(console, "info").mockImplementation((line: string) =>
			said.push(line),
		);
		vi.spyOn(console, "error").mockImplementation((line: string) =>
			said.push(line),
		);
		process.exitCode = 0;
		new EveryCaseRan().onTestRunEnd(ran as unknown as readonly TestModule[]);
		return { exitCode: process.exitCode, said: said.join("\n") };
	}

	it("fails a run any case skipped in, naming it", () => {
		const { exitCode, said } = report([
			file("engine.test.ts", [
				{ name: "resumes", state: "skipped", note: "No pi built" },
			]),
		]);
		expect(exitCode).toBe(1);
		expect(said).toContain("engine.test.ts: resumes: No pi built");
	});

	it("passes a run whose only skips are another platform's, naming them", () => {
		const other = process.platform === "linux" ? "darwin" : "linux";
		const { exitCode, said } = report([
			file("held-logs.test.ts", [
				{
					name: "holds a log once",
					state: "skipped",
					note: onlyOnNote(other, "probe"),
				},
			]),
		]);
		expect(exitCode).toBe(0);
		expect(said).toContain("let by 1 only another platform runs");
	});
});

describe("a platform's own case", () => {
	it("says the platform it runs on as it skips, and is read back by it", () => {
		const note = onlyOnNote("linux", "it reads /proc");
		expect(note).toBe("only on linux: it reads /proc");
		expect(onlyOnPlatform(note)).toBe("linux");
		expect(onlyOnPlatform("No pi built")).toBeUndefined();
		expect(onlyOnPlatform(undefined)).toBeUndefined();
	});
});
