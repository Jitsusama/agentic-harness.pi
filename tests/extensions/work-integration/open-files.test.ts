/**
 * What the sweep takes from lsof on a Mac, where a listing it can't trust
 * whole must read as unknown, so no tree in use is taken for free.
 */
import { describe, expect, it } from "vitest";
import {
	LSOF_LIMIT_MS,
	listedOpenFiles,
	type RunProgram,
} from "../../../extensions/work-integration/open-files.ts";

/** The asking account and its own process. */
const LISTER = { uid: 501, pid: 4242 };

/** A whole listing: the asker's own process, and one in a tree. */
const WHOLE = [
	"p4242",
	"fcwd",
	"n/Users/joel",
	"p501",
	"fcwd",
	"n/trees/a",
	"",
].join("\n");

/** A runner that answers as given, noting what it was asked. */
function answering(
	answer: { stdout: string; stderr: string } | Error,
	asked: unknown[][] = [],
): RunProgram {
	return async (...args) => {
		asked.push(args);
		if (answer instanceof Error) throw answer;
		return answer;
	};
}

/** An error as execFile rejects with, carrying what it read. */
function rejected(fields: Record<string, unknown>): Error {
	return Object.assign(new Error("lsof failed"), { stdout: WHOLE, ...fields });
}

describe("what lsof lists for the sweep", () => {
	it("gives a whole listing, asked of this account's processes within the lock's wait", async () => {
		const asked: unknown[][] = [];

		const listed = await listedOpenFiles(
			answering({ stdout: WHOLE, stderr: "" }, asked),
			LISTER,
		);

		expect(listed, "a whole listing wasn't given").toBe(WHOLE);
		// The whole call, so a listing that runs unbounded under the lock,
		// or a bare name the sweep's PATH can't find, fails here.
		expect(asked[0], "lsof wasn't asked of this account, bounded").toEqual([
			"/usr/sbin/lsof",
			["-n", "-P", "-F", "n", "-u", "501"],
			expect.objectContaining({
				timeout: LSOF_LIMIT_MS,
				killSignal: "SIGKILL",
				// A busy Mac's listing ran to 66,418 lines, megabytes with
				// their paths, and one cut short can never say.
				maxBuffer: expect.toSatisfy(
					(most: unknown) =>
						typeof most === "number" && most >= 64 * 1024 * 1024,
				),
			}),
		]);
		expect(
			LSOF_LIMIT_MS,
			"lsof may outlast an ask's wait on the lock",
		).toBeLessThan(10_000);
		// execFile reads a limit of none as no limit at all.
		expect(LSOF_LIMIT_MS, "lsof runs with no limit").toBeGreaterThan(0);
	});

	it("can't say when lsof fails, runs past its time or is missing, whatever it wrote", async () => {
		const failures = {
			exited: rejected({ code: 1, stderr: "lsof: can't get UID" }),
			killed: rejected({ killed: true, signal: "SIGKILL" }),
			missing: rejected({ code: "ENOENT" }),
			overflowed: rejected({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
		};

		const read = Object.fromEntries(
			await Promise.all(
				Object.entries(failures).map(async ([why, error]) => [
					why,
					await listedOpenFiles(answering(error), LISTER),
				]),
			),
		);

		expect(read, "a failed listing was trusted").toEqual({
			exited: undefined,
			killed: undefined,
			missing: undefined,
			overflowed: undefined,
		});
	});

	it("can't say when a listing that ended well warned, was empty or left out the asker", async () => {
		const answers = {
			warned: { stdout: WHOLE, stderr: "lsof: WARNING: can't stat()\n" },
			empty: { stdout: "", stderr: "" },
			short: { stdout: "p501\nfcwd\nn/trees/a\n", stderr: "" },
			// Only near the asker's line: another process, and a file named so.
			near: { stdout: "p42420\nfcwd\nn/x/p4242\n", stderr: "" },
		};

		const read = Object.fromEntries(
			await Promise.all(
				Object.entries(answers).map(async ([why, answer]) => [
					why,
					await listedOpenFiles(answering(answer), LISTER),
				]),
			),
		);

		expect(read, "a listing that may have missed a holder was trusted").toEqual(
			{
				warned: undefined,
				empty: undefined,
				short: undefined,
				near: undefined,
			},
		);
	});

	it("can't say for an account it can't name", async () => {
		const listed = await listedOpenFiles(
			answering({ stdout: WHOLE, stderr: "" }),
			{
				uid: undefined,
				pid: 4242,
			},
		);

		expect(listed, "a listing of nobody's processes was trusted").toBe(
			undefined,
		);
	});
});
