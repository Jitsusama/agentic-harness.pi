/** A screen's start profiled now and then, said as whose code the thread ran. */
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ownerOf,
	ownersLine,
	type StartProfiler,
	startProfiler,
} from "../../../host/screen/start-profile.ts";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

/** How long the busy start keeps the thread, in ms: many samples' worth. */
const BUSY_MS = 150;

/**
 * How long a test of profiled starts may take, in ms: a profile's start
 * and stop took seconds on a loaded machine on 25 November.
 */
const PROFILED_MS = 30_000;

/** A window long enough that no test's starts cross into the next, in ms. */
const WINDOW_MS = 60_000;

/** A start that holds the thread in this file's own code. */
function busyStart(): Promise<void> {
	const until = Date.now() + BUSY_MS;
	let spun = 0;
	while (Date.now() < until) spun += Math.sqrt(spun + 1);
	return Promise.resolve();
}

/** Profile one start, answering the lines said of it once they all are. */
async function linesOf(
	profile: StartProfiler,
	start: () => Promise<void> = busyStart,
): Promise<string[]> {
	const lines: string[] = [];
	const { done } = await profile(start, (line) => lines.push(line));
	await done;
	return lines;
}

let folder: string;

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "start-profile-"));
});

afterEach(async () => {
	await chmod(folder, 0o700);
	await rm(folder, { recursive: true, force: true });
});

describe("a profiled start", { timeout: PROFILED_MS }, () => {
	// Which owner the loop's samples fall to is the frames' to say, since
	// V8 may inline the loop into its caller; ownerOf's cases test that.
	it("samples the start and keeps the profile", async () => {
		const [line] = await linesOf(startProfiler({ folder }));
		const sampled = /, of (\d+\.\d) s; kept in (.+)$/.exec(line ?? "");
		expect(line).toMatch(/^Screen start profiled: the thread's time went to /);
		expect(Number(sampled?.[1])).toBeGreaterThanOrEqual(0.1);
		const kept = (await readdir(folder)).filter((one) =>
			one.endsWith(".cpuprofile"),
		);
		expect(kept).toHaveLength(1);
		expect(sampled?.[2]).toBe(join(folder, kept[0] ?? ""));
		const profile = JSON.parse(await readFile(sampled?.[2] ?? "", "utf8"));
		expect(profile.samples.length).toBeGreaterThan(0);
	});

	it("profiles once in its window, asking the disk only once", async () => {
		let at = 0;
		const profile = startProfiler({ folder, every: 1000, now: () => at });
		expect(await linesOf(profile)).toHaveLength(1);
		// With the claim gone, only the process's own memory keeps the window.
		await rm(join(folder, "claim-0"));
		at = 999;
		expect(await linesOf(profile)).toEqual([]);
		at = 1000;
		expect(await linesOf(profile)).toEqual([
			expect.stringMatching(/^Screen start profiled/),
		]);
	});

	it("goes unprofiled in a window another process claimed", async () => {
		await writeFile(join(folder, "claim-7"), "");
		const profile = startProfiler({ folder, every: 1000, now: () => 7500 });
		expect(await linesOf(profile)).toEqual([]);
		expect(await readdir(folder)).toEqual(["claim-7"]);
	});

	it("claims a new window past an old claim, and lets the old one go", async () => {
		await writeFile(join(folder, "claim-3"), "");
		const profile = startProfiler({ folder, every: 1000, now: () => 7500 });
		expect(await linesOf(profile)).toHaveLength(1);
		const names = await readdir(folder);
		expect(names).toContain("claim-7");
		expect(names).not.toContain("claim-3");
	});

	it("profiles one start at a time, the other running unprofiled", async () => {
		let at = 0;
		const profile = startProfiler({ folder, every: 1000, now: () => at });
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = linesOf(profile, () => held);
		// Past the claim, so the first is sampling when the second starts.
		await new Promise((resolve) => setTimeout(resolve, 50));
		at = 5000;
		const second = await linesOf(profile);
		release();
		expect(second).toEqual([]);
		expect(await first).toEqual([
			expect.stringMatching(/^Screen start profiled/),
		]);
	});

	it("throws the start's own failure, still saying and keeping its profile", async () => {
		const broken = new Error("the start broke");
		let said: (line: string) => void = () => undefined;
		const line = new Promise<string>((resolve) => {
			said = resolve;
		});
		await expect(
			startProfiler({ folder })(() => Promise.reject(broken), said),
		).rejects.toBe(broken);
		expect(await line).toMatch(/^Screen start profiled: .*; kept in /);
	});

	it("samples no longer than its most, the start running on", async () => {
		const [line] = await linesOf(
			startProfiler({ folder, most: 100 }),
			() => new Promise((resolve) => setTimeout(resolve, 400)),
		);
		expect(line).toMatch(
			/, sampling only its first 0\.1 s as it ran on; kept in /,
		);
	});

	it("keeps only the newest five", async () => {
		for (const day of ["01", "02", "03", "04", "05", "06"])
			await writeFile(
				join(folder, `start-2026-11-${day}T00-00-00-000Z.cpuprofile`),
				"{}",
			);
		await linesOf(startProfiler({ folder }));
		const kept = (await readdir(folder))
			.filter((one) => one.endsWith(".cpuprofile"))
			.sort();
		expect(kept).toHaveLength(5);
		expect(kept.slice(0, 4)).toEqual([
			"start-2026-11-03T00-00-00-000Z.cpuprofile",
			"start-2026-11-04T00-00-00-000Z.cpuprofile",
			"start-2026-11-05T00-00-00-000Z.cpuprofile",
			"start-2026-11-06T00-00-00-000Z.cpuprofile",
		]);
	});

	it("says a profile it couldn't keep, the window still claimed", async () => {
		const [line] = await linesOf(startProfiler({ folder }), async () => {
			await chmod(folder, 0o500);
			await busyStart();
		});
		expect(line).toMatch(/^Screen start profiled: .*; not kept: /);
		expect(
			(await readdir(folder)).filter((one) => one.startsWith("claim-")),
		).toHaveLength(1);
	});

	it("starts unprofiled when its folder can't be claimed, saying so once", async () => {
		const file = join(folder, "not-a-folder");
		await writeFile(file, "");
		let ran = 0;
		const profile = startProfiler({ folder: file, every: WINDOW_MS });
		const start = () => {
			ran += 1;
			return Promise.resolve();
		};
		expect(await linesOf(profile, start)).toEqual([
			expect.stringMatching(
				/^Screen start not profiled: couldn't claim its folder/,
			),
		]);
		expect(await linesOf(profile, start)).toEqual([]);
		expect(ran).toBe(2);
	});
});

describe("whose code a frame runs", () => {
	const at = (path: string) => ({
		functionName: "f",
		url: pathToFileURL(path).href,
	});

	it.each([
		[{ functionName: "(idle)", url: "" }, "idle"],
		[{ functionName: "(garbage collector)", url: "" }, "garbage collection"],
		[{ functionName: "(program)", url: "" }, "native code"],
		[{ functionName: "parse", url: "" }, "native code"],
		[{ functionName: "readFileSync", url: "node:fs" }, "node"],
		[at(join(ROOT, "extensions/quest-workflow/index.ts")), "quest-workflow"],
		[at(join(ROOT, "packs/browser/index.ts")), "browser"],
		[at(join(ROOT, "lib/core/work/memory.ts")), "the harness's lib"],
		[at(join(ROOT, "node_modules/yaml/dist/a.js")), "yaml"],
		[at("/x/node_modules/@earendil-works/pi-tui/dist/a.js"), "pi"],
		[at("/x/lib/node_modules/pi-monorepo/dist/a.js"), "pi"],
		[
			at("/x/node_modules/.pnpm/y/node_modules/@sinclair/typebox/a.js"),
			"@sinclair/typebox",
		],
		[at("/x/node_modules/yaml/dist/a.js"), "yaml"],
		[at("/somewhere/else.js"), "other"],
		[{ functionName: "f", url: "file://a-host/b.js" }, "other"],
	])("%o is %s's", (frame, owner) => {
		expect(ownerOf(frame)).toBe(owner);
	});

	const INSTALL = "/i/agentic-harness.pi";
	const VERSION = `${INSTALL}/versions/abc`;

	it.each([
		[`${VERSION}/extensions/quest-workflow/index.ts`, "quest-workflow"],
		[`${INSTALL}/current/extensions/mesh-workflow/index.ts`, "mesh-workflow"],
		[`${INSTALL}/versions/def/packs/browser/index.ts`, "browser"],
		[`${INSTALL}/current/host/screen/screens.ts`, "the harness's host"],
		[`${VERSION}/node_modules/yaml/dist/a.js`, "yaml"],
		[`${INSTALL}/retired/abc/extensions/x/index.ts`, "other"],
	])("under an install, %s is %s's", (path, owner) => {
		expect(ownerOf(at(path), VERSION)).toBe(owner);
	});

	it("names an extension of a harness installed under node_modules", () => {
		const root = "/c/node_modules/agentic-harness.pi";
		expect(ownerOf(at(`${root}/extensions/work-workflow/a.ts`), root)).toBe(
			"work-workflow",
		);
	});
});

describe("the owners' line", () => {
	it("says the busiest first, each with its time, of the whole", () => {
		const profile = {
			nodes: [
				{ id: 1, callFrame: { functionName: "(idle)", url: "" } },
				{ id: 2, callFrame: { functionName: "f", url: "node:fs" } },
			],
			samples: [1, 2, 2, 1],
			timeDeltas: [100_000, 400_000, 500_000, 100_000],
		};
		expect(ownersLine(profile)).toBe("node 0.9 s, idle 0.2 s, of 1.1 s");
	});

	it("says when no sample was taken", () => {
		expect(ownersLine({ nodes: [] })).toBe(
			"nothing, since no sample was taken",
		);
	});
});
