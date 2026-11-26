import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOCKET_PATH_BYTES } from "../../../host/service/address.ts";
import { slotFolder, slotOf } from "../../../host/service/child-units.ts";
import { SOCKET_ROOT } from "../../setup/temp-root.ts";
import { shortRuntime } from "./support/short-runtime.ts";

const KEY = "work-background";
/** A conversation's id, the longest name a child's slot takes. */
const LONGEST = "00000000-0000-4000-8000-000000000000";
/**
 * The longest TMPDIR whose children fit: the helper's folder adds
 * "/rt-XXXXXX", 10 bytes, and a child's socket below it
 * "/pi-host/work-background.d/<id>.sock", 68, so 25 + 10 + 68 = 103.
 */
const FITTING = 25;

/** The run's short folder, which the run's teardown removes. */
const sockets = process.env[SOCKET_ROOT];

const made: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const folder of made.splice(0))
		await rm(folder, { recursive: true, force: true });
});

/** A TMPDIR of exactly `bytes`, padded out inside the run's short folder. */
async function tmpdirOf(root: string, bytes: number): Promise<string> {
	const padded = join(root, "x".repeat(bytes - root.length - 1));
	await mkdir(padded);
	made.push(padded);
	vi.stubEnv("TMPDIR", padded);
	return padded;
}

/** The longest child's slot the supervisor would make in `runtime`. */
function longestSlot(runtime: string) {
	return slotOf(slotFolder(runtime, KEY), KEY, LONGEST);
}

// Only the run's short folder is short enough to pad a TMPDIR to the
// limit inside; a run where /tmp can't be written has none.
describe.skipIf(sockets === undefined)("a short runtime folder", () => {
	const root = sockets ?? "";

	it("stays under the run's temp folder when its longest child's socket just fits", async () => {
		const temp = await tmpdirOf(root, FITTING);

		const runtime = await shortRuntime(KEY);

		expect(runtime.startsWith(`${temp}/rt-`), runtime).toBe(true);
		expect(Buffer.byteLength(longestSlot(runtime).socket), "at the limit").toBe(
			MAX_SOCKET_PATH_BYTES,
		);
	});

	it("goes under the run's short folder when that socket would be a byte too long, leaving nothing behind", async () => {
		const temp = await tmpdirOf(root, FITTING + 1);

		const runtime = await shortRuntime(KEY);
		made.push(runtime);

		expect(runtime.startsWith(`${root}/rt-`), runtime).toBe(true);
		expect(() => longestSlot(runtime), "its children fit").not.toThrow();
		expect(await readdir(temp), "the folder it tried first").toEqual([]);
	});
});
