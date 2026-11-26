/** A screen's start profiled now and then, said as whose code the thread ran. */
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ownerOf,
	ownersLine,
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

/** A start that holds the thread in this file's own code. */
function busyStart(): Promise<void> {
	const until = Date.now() + BUSY_MS;
	let spun = 0;
	while (Date.now() < until) spun += Math.sqrt(spun + 1);
	return Promise.resolve();
}

let folder: string;

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "start-profile-"));
});

afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("a profiled start", { timeout: PROFILED_MS }, () => {
	// Which owner the loop's samples fall to is the frames' to say, since
	// V8 may inline the loop into its caller; ownerOf's cases test that.
	it("samples the start and keeps the profile", async () => {
		const { line } = await startProfiler({ folder })(busyStart);
		const sampled = /, of (\d+\.\d) s; kept in (.+)$/.exec(line ?? "");
		expect(line).toMatch(/^Screen start profiled: the thread's time went to /);
		expect(Number(sampled?.[1])).toBeGreaterThanOrEqual(0.1);
		const kept = await readdir(folder);
		expect(kept).toHaveLength(1);
		expect(sampled?.[2]).toBe(join(folder, kept[0] ?? ""));
		const profile = JSON.parse(await readFile(sampled?.[2] ?? "", "utf8"));
		expect(profile.samples.length).toBeGreaterThan(0);
	});

	it("goes unprofiled when one was taken within its time", async () => {
		let at = 0;
		const profile = startProfiler({ folder, every: 1000, now: () => at });
		await profile(busyStart);
		at = 999;
		expect((await profile(busyStart)).line).toBeUndefined();
		at = Date.now() + 10_000;
		expect((await profile(busyStart)).line).toMatch(/^Screen start profiled/);
	});

	it("reads the last one from the folder, as another process's", async () => {
		await writeFile(join(folder, "start-another.cpuprofile"), "{}");
		const profile = startProfiler({ folder, every: 60_000 });
		expect((await profile(busyStart)).line).toBeUndefined();
	});

	it("profiles past a folder's last one once its time has gone", async () => {
		const old = join(folder, "start-another.cpuprofile");
		await writeFile(old, "{}");
		const longAgo = new Date(Date.now() - 120_000);
		await utimes(old, longAgo, longAgo);
		const profile = startProfiler({ folder, every: 60_000 });
		expect((await profile(busyStart)).line).toMatch(/^Screen start profiled/);
	});

	it("profiles one start at a time, the other running unprofiled", async () => {
		const profile = startProfiler({ folder, every: 0 });
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = profile(() => held);
		const second = await profile(busyStart);
		release();
		expect(second.line).toBeUndefined();
		expect((await first).line).toMatch(/^Screen start profiled/);
	});

	it("throws the start's own failure", async () => {
		const broken = new Error("the start broke");
		await expect(
			startProfiler({ folder })(() => Promise.reject(broken)),
		).rejects.toBe(broken);
	});

	it("keeps only the newest five", async () => {
		for (const day of ["01", "02", "03", "04", "05", "06"])
			await writeFile(
				join(folder, `start-2026-11-${day}T00-00-00-000Z.cpuprofile`),
				"{}",
			);
		const longAgo = new Date(Date.now() - 120_000);
		await utimes(
			join(folder, "start-2026-11-06T00-00-00-000Z.cpuprofile"),
			longAgo,
			longAgo,
		);
		await startProfiler({ folder, every: 60_000 })(busyStart);
		const kept = (await readdir(folder)).sort();
		expect(kept).toHaveLength(5);
		expect(kept.slice(0, 4)).toEqual([
			"start-2026-11-03T00-00-00-000Z.cpuprofile",
			"start-2026-11-04T00-00-00-000Z.cpuprofile",
			"start-2026-11-05T00-00-00-000Z.cpuprofile",
			"start-2026-11-06T00-00-00-000Z.cpuprofile",
		]);
	});

	it("starts unprofiled when its folder can't be read", async () => {
		const file = join(folder, "not-a-folder");
		await writeFile(file, "");
		let ran = false;
		const { line } = await startProfiler({ folder: file })(() => {
			ran = true;
			return Promise.resolve();
		});
		expect(ran).toBe(true);
		expect(line).toMatch(
			/^Screen start not profiled: couldn't read its folder/,
		);
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
		[at("/x/node_modules/@earendil-works/pi-tui/dist/a.js"), "pi"],
		[at("/x/lib/node_modules/pi-monorepo/dist/a.js"), "pi"],
		[
			at("/x/node_modules/.pnpm/y/node_modules/@sinclair/typebox/a.js"),
			"@sinclair/typebox",
		],
		[at("/x/node_modules/yaml/dist/a.js"), "yaml"],
		[at("/somewhere/else.js"), "other"],
	])("%o is %s's", (frame, owner) => {
		expect(ownerOf(frame)).toBe(owner);
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
			timeDeltas: [0, 400_000, 500_000, 100_000],
		};
		expect(ownersLine(profile)).toBe("node 0.9 s, idle 0.1 s, of 1.0 s");
	});

	it("says when no sample was taken", () => {
		expect(ownersLine({ nodes: [] })).toBe(
			"nothing, since no sample was taken",
		);
	});
});
