import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOCKET_PATH_BYTES } from "../../../host/service/address.ts";
import { slotFolder } from "../../../host/service/child-units.ts";
import { shortRuntime } from "./support/short-runtime.ts";

const KEY = "work-background";
const LONGEST = "00000000-0000-4000-8000-000000000000.sock";

const made: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const folder of made.splice(0))
		await rm(folder, { recursive: true, force: true });
});

/** The bytes of the longest child's socket a host keyed KEY makes in `runtime`. */
function longestSocket(runtime: string): number {
	return Buffer.byteLength(join(slotFolder(runtime, KEY), LONGEST));
}

describe("a short runtime folder", () => {
	it("stays under the run's temp folder when a child's socket fits there", async () => {
		// Short whatever temp folder this run was given.
		const short = await mkdtemp(join("/tmp", "sr-"));
		made.push(short);
		vi.stubEnv("TMPDIR", short);

		const runtime = await shortRuntime(KEY);

		expect(runtime.startsWith(`${short}/rt-`), runtime).toBe(true);
		expect(longestSocket(runtime)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
	});

	it("goes under /tmp when the run's temp folder is too long, leaving nothing there", async () => {
		const long = join(tmpdir(), "x".repeat(80));
		await mkdir(long);
		made.push(long);
		vi.stubEnv("TMPDIR", long);

		const runtime = await shortRuntime(KEY);
		made.push(runtime);

		expect(runtime.startsWith("/tmp/rt-"), runtime).toBe(true);
		expect(longestSocket(runtime)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
		expect(await readdir(long), "the folder it tried first").toEqual([]);
	});
});
