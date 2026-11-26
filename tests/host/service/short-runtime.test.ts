import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * Whether this run may write /tmp, probed rather than read from the
 * setup, so a setup that stops naming its folder fails here rather than
 * skipping. Only a refusal counts; any other error fails the file.
 */
function mayWriteTmp(): boolean {
	try {
		rmSync(mkdtempSync("/tmp/sr-probe-"), { recursive: true });
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		if (["EACCES", "EPERM", "EROFS"].includes(code)) return false;
		throw error;
	}
}

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
// limit inside; a run that may not write /tmp, as under the sandbox, has
// none.
describe.skipIf(!mayWriteTmp())("a short runtime folder", () => {
	const root = sockets ?? "";

	it("is named by the run's setup wherever /tmp may be written", () => {
		expect(sockets, "the run's short folder").toMatch(/^\/tmp\/vs-/);
	});

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
		expect(
			() => longestSlot(join(temp, "rt-XXXXXX")),
			"the supervisor refuses the folder it passed over",
		).toThrow();
		expect(() => longestSlot(runtime), "its children fit").not.toThrow();
		expect(await readdir(temp), "the folder it tried first").toEqual([]);
	});
});

describe("a runtime folder with no short folder named", () => {
	it("stays under the run's temp folder, however long, so only a test needing children fails", async () => {
		const temp = join(tmpdir(), "x".repeat(40));
		await mkdir(temp);
		made.push(temp);
		vi.stubEnv("TMPDIR", temp);
		vi.stubEnv(SOCKET_ROOT, undefined);

		const runtime = await shortRuntime(KEY);

		expect(runtime.startsWith(`${temp}/rt-`), runtime).toBe(true);
		expect(() => longestSlot(runtime), "too long for children").toThrow();
	});
});
