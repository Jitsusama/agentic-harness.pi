/**
 * The host gate's reporter, on the cases a run ended with: it names each
 * that skipped, with its note, and nothing that passed or failed, letting
 * by only a case whose meta names another platform as its own.
 */

import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import type { TestModule } from "vitest/node";
import EveryCaseRan, { skipsIn } from "./every-case-ran.mts";
import { onlyOnBody, onlyOnNote } from "./only-on.mts";

/** A case as a file ended it: its name, its state, and its note and meta if any. */
interface Case {
	readonly name: string;
	readonly state: string;
	readonly note?: string;
	readonly onlyOn?: string;
}

/** A file whose cases ended as given. */
function file(moduleId: string, cases: readonly Case[]) {
	return {
		moduleId,
		children: {
			*allTests() {
				for (const { name, state, note, onlyOn } of cases)
					yield {
						fullName: name,
						result: () => (note === undefined ? { state } : { state, note }),
						meta: () => (onlyOn === undefined ? {} : { onlyOn }),
					};
			},
		},
	};
}

/** A case only `platform` runs, as it ended skipped on another. */
function onlyOn(name: string, platform: NodeJS.Platform): Case {
	return {
		name,
		state: "skipped",
		note: onlyOnNote(platform, "it reads /proc"),
		onlyOn: platform,
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
		const ran = [file("engine.test.ts", [onlyOn("holds a log", "linux")])];
		const line = `engine.test.ts: holds a log: ${onlyOnNote("linux", "it reads /proc")}`;
		expect(skipsIn(ran, "", "darwin"), "on the Mac").toEqual({
			refused: [],
			elsewhere: [line],
		});
		expect(skipsIn(ran, "", "linux"), "on Linux itself").toEqual({
			refused: [line],
			elsewhere: [],
		});
	});

	it("refuses a note naming another platform when the meta names none", () => {
		const note = onlyOnNote("linux", "it reads /proc");
		const ran = [
			file("engine.test.ts", [{ name: "resumes", state: "skipped", note }]),
		];
		expect(skipsIn(ran, "", "darwin")).toEqual({
			refused: [`engine.test.ts: resumes: ${note}`],
			elsewhere: [],
		});
	});

	it("refuses a meta naming a platform Node doesn't know", () => {
		const note = "only on never: it can't run anywhere";
		const ran = [
			file("engine.test.ts", [
				{ name: "resumes", state: "skipped", note, onlyOn: "never" },
			]),
		];
		expect(skipsIn(ran, "", "linux")).toEqual({
			refused: [`engine.test.ts: resumes: ${note}`],
			elsewhere: [],
		});
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

	const other = process.platform === "linux" ? "darwin" : "linux";

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
		const { exitCode, said } = report([
			file("held-logs.test.ts", [onlyOn("holds a log once", other)]),
		]);
		expect(exitCode).toBe(0);
		expect(said).toContain("let by 1 only another platform runs");
		expect(said).toContain("held-logs.test.ts: holds a log once");
	});

	it("fails a run that let one skip by and refused another, naming each", () => {
		const { exitCode, said } = report([
			file("engine.test.ts", [
				onlyOn("holds a log once", other),
				{ name: "resumes", state: "skipped", note: "No pi built" },
			]),
		]);
		expect(exitCode).toBe(1);
		expect(said).toContain("let by 1 only another platform runs");
		expect(said).toContain(
			"1 skipped:\n  engine.test.ts: resumes: No pi built",
		);
	});
});

describe("a case only one platform runs", () => {
	/** What a body did when run: whether `fn` ran, the note it skipped with, and its meta. */
	function ran(body: ReturnType<typeof onlyOnBody>) {
		const meta: Record<string, unknown> = {};
		let skipped: string | undefined;
		const context = {
			task: { meta },
			skip: (note?: string) => {
				skipped = note;
			},
		};
		body(context as unknown as TestContext);
		return { skipped, meta };
	}

	it("runs its own body on its platform", () => {
		const fn = vi.fn();
		ran(onlyOnBody("linux", "it reads /proc", fn, "linux"));
		expect(fn).toHaveBeenCalledOnce();
	});

	it("skips elsewhere, naming its platform in its note and its meta", () => {
		const fn = vi.fn();
		const { skipped, meta } = ran(
			onlyOnBody("linux", "it reads /proc", fn, "darwin"),
		);
		expect(fn).not.toHaveBeenCalled();
		expect(skipped).toBe("only on linux: it reads /proc");
		expect(meta).toEqual({ onlyOn: "linux" });
	});
});
