/**
 * The host gate's reporter, on the cases a run ended with: it names each
 * that skipped, with its note, and nothing that passed or failed, letting
 * by only a case whose meta names Linux as its own, on a Mac.
 */

import {
	afterEach,
	describe,
	expect,
	it,
	onTestFinished,
	type TestContext,
	vi,
} from "vitest";
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

	it("lets by a case only Linux runs on a Mac, and refuses it on Linux itself", () => {
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

	it("refuses on Linux a case only another platform runs, since every case must run there", () => {
		const mac = [file("engine.test.ts", [onlyOn("holds a log", "darwin")])];
		expect(skipsIn(mac, "", "linux"), "a Mac's case").toEqual({
			refused: [
				`engine.test.ts: holds a log: ${onlyOnNote("darwin", "it reads /proc")}`,
			],
			elsewhere: [],
		});
		const windows = [file("engine.test.ts", [onlyOn("holds a log", "win32")])];
		expect(skipsIn(windows, "", "linux").elsewhere, "Windows's").toEqual([]);
	});

	it("lets by on a Mac only a case Linux runs, not another platform's", () => {
		const windows = [file("engine.test.ts", [onlyOn("holds a log", "win32")])];
		expect(skipsIn(windows, "", "darwin")).toEqual({
			refused: [
				`engine.test.ts: holds a log: ${onlyOnNote("win32", "it reads /proc")}`,
			],
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

	/** The exit code and what it said, after a run on `platform` that ended with `ran`. */
	function report(
		ran: readonly ReturnType<typeof file>[],
		platform: NodeJS.Platform,
	) {
		const said: string[] = [];
		const real = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: platform });
		onTestFinished(() => {
			if (real) Object.defineProperty(process, "platform", real);
		});
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
		const { exitCode, said } = report(
			[
				file("engine.test.ts", [
					{ name: "resumes", state: "skipped", note: "No pi built" },
				]),
			],
			"linux",
		);
		expect(exitCode).toBe(1);
		expect(said).toContain("engine.test.ts: resumes: No pi built");
	});

	it("passes a Mac's run whose only skips are Linux's, naming them", () => {
		const { exitCode, said } = report(
			[file("held-logs.test.ts", [onlyOn("holds a log once", "linux")])],
			"darwin",
		);
		expect(exitCode).toBe(0);
		expect(said).toContain("let by 1 only Linux runs");
		expect(said).toContain("held-logs.test.ts: holds a log once");
	});

	it("fails a Linux run whose cases skipped as only a Mac's or a made-up platform's, naming each", () => {
		const made = "only on never: it can't run anywhere";
		const { exitCode, said } = report(
			[
				file("held-logs.test.ts", [
					onlyOn("holds a log once", "darwin"),
					{ name: "resumes", state: "skipped", note: made, onlyOn: "never" },
				]),
			],
			"linux",
		);
		expect(exitCode).toBe(1);
		expect(said).not.toContain("let by");
		expect(said).toContain(
			`2 skipped:\n  held-logs.test.ts: holds a log once: ${onlyOnNote("darwin", "it reads /proc")}\n  held-logs.test.ts: resumes: ${made}`,
		);
	});

	it("fails a run that let one skip by and refused another, naming each", () => {
		const { exitCode, said } = report(
			[
				file("engine.test.ts", [
					onlyOn("holds a log once", "linux"),
					{ name: "resumes", state: "skipped", note: "No pi built" },
				]),
			],
			"darwin",
		);
		expect(exitCode).toBe(1);
		expect(said).toContain("let by 1 only Linux runs");
		expect(said).toContain(
			"1 skipped:\n  engine.test.ts: resumes: No pi built",
		);
	});
});

describe("a case only one platform runs", () => {
	/** What vitest's skip throws to end a case, as the fake's does. */
	class Skipped extends Error {}

	/** What a body did when run: whether `fn` ran, the note it skipped with, and its meta. */
	function ran(body: ReturnType<typeof onlyOnBody>) {
		const meta: Record<string, unknown> = {};
		let skipped: string | undefined;
		const context = {
			task: { meta },
			// vitest's skip throws, so nothing after it in the body runs.
			skip: (note?: string) => {
				skipped = note;
				throw new Skipped(note);
			},
		};
		try {
			body(context as unknown as TestContext);
		} catch (error) {
			if (!(error instanceof Skipped)) throw error;
		}
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
		expect(meta).toEqual({ onlyOn: "linux", skippedOn: "darwin" });
	});
});
