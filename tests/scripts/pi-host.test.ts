/**
 * pi-host as a unit runs it: node running the script as it stands, in a
 * sealed environment of its own, exiting 78 when what it was given is
 * refused, so a unit naming that status stops restarting it.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "pi-host.ts");

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** pi-host's standard error and exit code, run by node under a sealed `env`. */
async function piHost(env: NodeJS.ProcessEnv, ...args: string[]) {
	return run(
		process.execPath,
		["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCRIPT, ...args],
		{ env, timeout: 20_000 },
	).then(
		(done) => ({ code: 0, stderr: done.stderr }),
		(failed: { code?: number; stderr?: string }) => ({
			code: failed.code ?? -1,
			stderr: failed.stderr ?? "",
		}),
	);
}

describe("pi-host", () => {
	it("exits 78 with only the reason when its pi install is refused, leaving no socket", async () => {
		const home = mkdtempSync(join(tmpdir(), "h2-pi-host-"));
		made.push(home);
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			XDG_RUNTIME_DIR: join(home, "run"),
			XDG_STATE_HOME: join(home, "state"),
			MYCELIUM_REALM: "work",
			PI_PACKAGE_DIR: join(home, "no-pi"),
		};
		const refused = await piHost(env, "attended");
		expect(refused.code).toBe(78);
		expect(refused.stderr).toMatch(/^pi-host: The pi at .*no-pi is incomplete/);
		expect(refused.stderr, "no stack for a refusal").not.toContain("    at ");
		expect(readdirSync(home), "nothing was made").toEqual([]);

		expect((await piHost(env, "sideways")).code).toBe(78);
	});
});
