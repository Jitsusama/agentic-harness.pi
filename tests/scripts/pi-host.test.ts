/**
 * pi-host as a unit runs it: node running the script as it stands, in a
 * sealed environment of its own, exiting 78 when what it was given is
 * refused, so a unit naming that status stops restarting it.
 */

import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		expect(bare.code).toBe(78);
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
		expect(refused.code).toBe(78);
		expect(refused.stderr).toMatch(/^pi-host: The pi at .*no-pi is incomplete/);
		expect(refused.stderr, "no stack for a refusal").not.toContain("    at ");
		expect(readdirSync(home), "nothing was made").toEqual([]);

		expect((await piHost(env, "sideways")).code).toBe(78);
	});

	// A bundle from before typebox was shared hands extensions typebox with no
	// host module for it. The host's protocol loads as the program does, before
	// the pi is judged, so this is the start the unit sees, not a module load.
	it("exits 78 with only the reason when its pi's bundle shares no typebox with the host", async () => {
		const home = mkdtempSync(join(tmpdir(), "h2-pi-host-"));
		const runtime = mkdtempSync(join(tmpdir(), "h2-pi-host-runtime-"));
		made.push(home, runtime);
		const pi = join(runtime, "pi");
		mkdirSync(join(pi, "dist", "bundle"), { recursive: true });
		writeFileSync(join(pi, "package.json"), "{}\n");
		writeFileSync(
			join(pi, "dist", "bundle", "host.js"),
			"export const hostEntryVersion = 1;\nexport const VIRTUAL_MODULES = { typebox: {} };\n",
		);
		const proof = join(runtime, "proof.json");
		writeFileSync(
			proof,
			JSON.stringify({
				kind: "pi-host-runtime-proof",
				version: 1,
				runtime,
				harness: "8bd554ed03f8",
				files: 14,
				cases: 71,
				provenAt: "2026-11-10T11:00:00.000Z",
			}),
		);
		const refused = await piHost(
			{
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				XDG_RUNTIME_DIR: join(home, "run"),
				XDG_STATE_HOME: join(home, "state"),
				MYCELIUM_REALM: "work",
				PI_PACKAGE_DIR: pi,
				PI_HOST_PROOF: proof,
			},
			"attended",
		);
		expect(refused.code, refused.stderr).toBe(78);
		expect(refused.stderr).toMatch(
			/^pi-host: .*host\.js has no host module for typebox, so the host's own imports would load a second copy/,
		);
		expect(refused.stderr, "no stack for a refusal").not.toContain("    at ");
		// The compile cache is made for an install that exists; no socket is.
		expect(readdirSync(home), "only the compile cache's state").toEqual([
			"state",
		]);
	});
});
