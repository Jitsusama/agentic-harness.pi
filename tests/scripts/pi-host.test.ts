/**
 * pi-host as a unit runs it: node running the script as it stands, in a
 * sealed environment of its own, exiting 78 when what it was given is
 * refused, so a unit naming that status stops restarting it.
 *
 * It is the check for a load the walk in
 * tests/host/service/program-binds-no-pi-at-load.test.ts can't see,
 * such as an `import()` in a function called at load. It runs in this
 * tree, where the optional peers and dev dependencies resolve, so
 * pi-host runs with a hook refusing each of them to the tree's own
 * code, as an install of production dependencies lacks them; a load of
 * one ahead of the refusal then exits 1 here, as it would there. Running pi-host
 * as a process imports none of it, so this file imports the program
 * and what pi-host loads before its hook, for `vitest --changed` to
 * pick it for a change anywhere they reach; that walk fails when
 * pi-host imports a module this file doesn't.
 */

import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import "../../host/service/compile-cache.ts";
import "../../host/service/pi-resolution.ts";
import { EXIT_MISCONFIGURED } from "../../host/service/program.ts";
import "../../host/service/run.ts";
import "../../lib/internal/fence/compile-cache-place.ts";
import { isRecord } from "../../lib/internal/record.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "pi-host.ts");

/** How long one pi-host run may take, under a busy machine. */
const ONE_RUN = 20_000;
/** How long the three runs of the refusal test may take. */
const THREE_RUNS = 3 * ONE_RUN;

/** What a refused package says, so a test can tell the hook's refusal from node's. */
const REFUSED = "lacking in a production install";

/**
 * The packages an install of production dependencies lacks: each
 * optional peer, and each dev dependency that isn't also a dependency.
 */
function productionLacks(): string[] {
	const manifest: unknown = JSON.parse(
		readFileSync(join(ROOT, "package.json"), "utf8"),
	);
	const field = (name: string): Record<string, unknown> => {
		const value = isRecord(manifest) ? manifest[name] : undefined;
		return isRecord(value) ? value : {};
	};
	const meta = field("peerDependenciesMeta");
	const peers = Object.keys(field("peerDependencies")).filter((name) => {
		const of = meta[name];
		return isRecord(of) && of.optional === true;
	});
	const dependencies = new Set(Object.keys(field("dependencies")));
	const devOnly = Object.keys(field("devDependencies")).filter(
		(name) => !dependencies.has(name),
	);
	return [...new Set([...peers, ...devOnly])];
}

/**
 * node's `--import` of a resolve hook refusing each of `lacking` to code
 * under `root` outside its node_modules, as `--import` takes it: a
 * data URL, so the hook needs no file. node runs the hook registered
 * last first, so pi-host's own hook still sends pi's scope to its
 * install before this one sees it.
 */
function refusing(lacking: readonly string[], root: string): string {
	const code = [
		'import { registerHooks } from "node:module";',
		`const lacking = new Set(${JSON.stringify(lacking)});`,
		// node names a parent by its real path, past any link on the way.
		`const root = ${JSON.stringify(pathToFileURL(join(realpathSync(root), "/")).href)};`,
		"registerHooks({ resolve(specifier, context, next) {",
		'\tconst parts = specifier.split("/");',
		'\tconst name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];',
		'\tconst parent = context.parentURL ?? "";',
		'\tif (lacking.has(name) && parent.startsWith(root) && !parent.includes("/node_modules/")) {',
		`\t\tconst error = new Error(name + " is ${REFUSED}, loaded from " + parent);`,
		'\t\terror.code = "ERR_MODULE_NOT_FOUND";',
		"\t\tthrow error;",
		"\t}",
		"\treturn next(specifier, context);",
		"} });",
	].join("\n");
	return `--import=data:text/javascript,${encodeURIComponent(code)}`;
}

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** pi-host's standard error and exit code, run by node under a sealed `env`. */
async function piHost(env: NodeJS.ProcessEnv, ...args: string[]) {
	return run(
		process.execPath,
		[
			"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
			refusing(productionLacks(), ROOT),
			SCRIPT,
			...args,
		],
		{ env, timeout: ONE_RUN },
	).then(
		(done) => ({ code: 0, stderr: done.stderr }),
		(failed: { code?: number; stderr?: string }) => ({
			code: failed.code ?? -1,
			stderr: failed.stderr ?? "",
		}),
	);
}

describe("pi-host", () => {
	it(
		"exits 78 with only the reason when its proof or pi install is refused, leaving no socket",
		async () => {
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
			expect(bare.stderr).toMatch(
				/^pi-host: PI_HOST_PROOF must name the proof/,
			);

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
			expect(refused.stderr).toMatch(
				/^pi-host: The pi at .*no-pi is incomplete/,
			);
			expect(refused.stderr, "no stack for a refusal").not.toContain("    at ");
			expect(readdirSync(home), "nothing was made").toEqual([]);

			expect((await piHost(env, "sideways")).code).toBe(EXIT_MISCONFIGURED);
		},
		THREE_RUNS,
	);

	it(
		"refuses the tree's own code each optional peer and dev dependency, as a production install lacks them, and no dependency",
		async () => {
			const lacking = productionLacks();
			expect(lacking).toEqual(
				expect.arrayContaining(["typebox", "@earendil-works/pi-coding-agent"]),
			);
			// Run in the tree's root, under the hook pi-host runs under: node
			// names an eval's parent by the folder it runs in, so the hook
			// judges it as it judges pi-host's own files, where typebox does
			// resolve, as it wouldn't in a production install.
			const load = (name: string) =>
				run(
					process.execPath,
					[
						refusing(lacking, ROOT),
						"--input-type=module",
						"--eval",
						`await import(${JSON.stringify(name)});`,
					],
					{ cwd: ROOT, timeout: ONE_RUN },
				).then(
					() => "",
					(failed: { stderr?: string }) => failed.stderr ?? "failed",
				);
			expect(await load("typebox")).toContain(`typebox is ${REFUSED}`);
			expect(await load("jsonpath-plus"), "a dependency loads").toBe("");
		},
		2 * ONE_RUN,
	);
});
