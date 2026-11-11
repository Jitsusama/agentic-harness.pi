/**
 * host-join run as a window runs it, by node in a sealed environment of
 * its own: under no holder, a view or a release runs what comes next
 * itself and ends as that does, while a move, which only a holder can
 * carry on past, is refused.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "host-join.ts");
const PLAIN_PI = ["sh", "-c", "echo carried on as plain pi; exit 4"];

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** host-join's output and exit code, run by node under a sealed `env`. */
async function hostJoin(...args: string[]) {
	const home = mkdtempSync(join(tmpdir(), "h2-host-join-"));
	made.push(home);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: home,
		XDG_RUNTIME_DIR: join(home, "run"),
		XDG_STATE_HOME: join(home, "state"),
	};
	return run(
		process.execPath,
		["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args],
		{ env, timeout: 20_000 },
	).then(
		(done) => ({ code: 0, stdout: done.stdout, stderr: done.stderr }),
		(failed: { code?: number; stdout?: string; stderr?: string }) => ({
			code: failed.code ?? -1,
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
		}),
	);
}

describe("host-join under no holder", () => {
	it("runs plain pi itself for a view no host holds, ending as it ends", async () => {
		const joined = await hostJoin(
			"--view",
			"--session",
			"01a1",
			"--",
			...PLAIN_PI,
		);
		expect(joined.stdout).toBe("carried on as plain pi\n");
		expect(joined.code).toBe(4);
	});

	it("refuses a move, which only a holder carries on past", async () => {
		const joined = await hostJoin("--session", "01a1", "--", ...PLAIN_PI);
		expect(joined.code).not.toBe(0);
		expect(joined.stdout).toBe("");
		expect(joined.stderr).toContain("runs under a mycelium holder");
	});
});
