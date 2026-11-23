/**
 * pi-host as a unit runs it: node running the script as it stands, in a
 * sealed environment of its own, exiting 78 when what it was given is
 * refused, so a unit naming that status stops restarting it.
 *
 * It is the check for a load the walk in
 * tests/host/service/program-binds-no-pi-at-load.test.ts can't see,
 * such as an `import()` in a function called at load, within pi's
 * scope only: it runs in this tree, where typebox and the dev
 * dependencies resolve, so such a load of one passes here. Running pi-host
 * as a process imports none of it, so this file imports the program
 * and what pi-host loads before its hook, for `vitest --changed` to
 * pick it for a change anywhere they reach; that walk fails when
 * pi-host imports a module this file doesn't.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import "../../host/service/compile-cache.ts";
import "../../host/service/pi-resolution.ts";
import { EXIT_MISCONFIGURED } from "../../host/service/program.ts";
import "../../host/service/run.ts";
import "../../lib/internal/fence/compile-cache-place.ts";

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
	it("exits 78 with only the reason when its proof or pi install is refused, leaving no socket", async () => {
		const home = mkdtempSync(join(tmpdir(), "h2-pi-host-"));
		const proofs = mkdtempSync(join(tmpdir(), "h2-pi-host-proofs-"));
		made.push(home, proofs);
		const unproven = {
			PATH: process.env.PATH,
			HOME: home,
			TMPDIR: home,
			XDG_RUNTIME_DIR: join(home, "run"),
			XDG_STATE_HOME: join(home, "state"),
			MYCELIUM_REALM: "work",
			PI_PACKAGE_DIR: join(home, "no-pi"),
		};
		const bare = await piHost(unproven, "attended");
		expect(bare.code).toBe(EXIT_MISCONFIGURED);
		expect(bare.stderr).toMatch(/^pi-host: PI_HOST_PROOF must name the proof/);

		const proof = join(proofs, "proof.json");
		writeFileSync(
			proof,
			JSON.stringify({
				kind: "pi-host-runtime-proof",
				version: 1,
				runtime: home,
				harness: "8bd554ed03f8",
				files: 14,
				cases: 71,
				provenAt: "2026-11-10T11:00:00.000Z",
			}),
		);
		const env = { ...unproven, PI_HOST_PROOF: proof };
		const refused = await piHost(env, "attended");
		expect(refused.code).toBe(EXIT_MISCONFIGURED);
		expect(refused.stderr).toMatch(/^pi-host: The pi at .*no-pi is incomplete/);
		expect(refused.stderr, "no stack for a refusal").not.toContain("    at ");
		expect(readdirSync(home), "nothing was made").toEqual([]);

		expect((await piHost(env, "sideways")).code).toBe(EXIT_MISCONFIGURED);
	});
});
