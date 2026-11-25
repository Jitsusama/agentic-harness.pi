/**
 * The stripped-source cache in a node of its own: a module read back
 * runs as node ran it, and node loads no transpiler for it. Whatever
 * node runs this, the cache starts as it would on node 22, so the case
 * holds on the node the tests run on.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { OFF_VARIABLE } from "../../../lib/internal/stripped-source.mjs";
import { supervisorArguments } from "../../../lib/subagent/runpi/supervisor-request.ts";

const run = promisify(execFile);

/** How long one child node may take, under a busy machine. */
const ONE_RUN = 20_000;

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "stripped-node-")));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/**
 * A child node's `--import`, starting the cache as node 22 would in
 * whatever node runs it, and failing the run should it not start.
 */
function startingAs22(): string {
	const module = pathToFileURL(
		join(import.meta.dirname, "../../../lib/internal/stripped-source.mjs"),
	).href;
	const code = [
		`import { startStrippedSourceCache } from ${JSON.stringify(module)};`,
		"const started = startStrippedSourceCache({ facts: { env: process.env,",
		'\tversion: "v22.0.0", typescript: process.features.typescript,',
		"\tsourceMaps: process.sourceMapsEnabled } });",
		'if (started.state === "failed") throw new Error(started.reason);',
	].join("\n");
	return `--import=data:text/javascript,${encodeURIComponent(code)}`;
}

/** A TypeScript module saying how it was loaded, in a folder of its own. */
async function sayingModule(): Promise<string> {
	const code = join(root, "code");
	await mkdir(code);
	await writeFile(join(code, "package.json"), '{ "type": "module" }\n');
	const entry = join(code, "entry.ts");
	await writeFile(
		entry,
		[
			"interface Pair { a: number; b: number }",
			"export function add({ a, b }: Pair): number { return a + b; }",
			'const where: string = new Error("here").stack?.split("\\n")[1] ?? "";',
			"console.log(JSON.stringify({ fn: add.toString(), where,",
			'\ttranspiler: process.moduleLoadList.some((m: string) => m.includes("amaro")) }));',
		].join("\n"),
	);
	return entry;
}

/** What the module at `entry` says of itself, run with `hook` first. */
async function says(
	entry: string,
	env: NodeJS.ProcessEnv,
	hook?: string,
): Promise<{ fn: string; where: string; transpiler: boolean }> {
	const { stdout } = await run(
		process.execPath,
		[...(hook ? [hook] : []), entry],
		{ env: { PATH: process.env.PATH, HOME: root, ...env }, timeout: ONE_RUN },
	);
	const told: unknown = JSON.parse(stdout);
	if (
		!isRecord(told) ||
		typeof told.fn !== "string" ||
		typeof told.where !== "string" ||
		typeof told.transpiler !== "boolean"
	)
		throw new Error(`the module said ${stdout}`);
	return { fn: told.fn, where: told.where, transpiler: told.transpiler };
}

describe("the stripped-source cache in a node", () => {
	it(
		"runs a module read back as node ran it, with no transpiler loaded",
		async () => {
			const entry = await sayingModule();
			const env = { XDG_STATE_HOME: join(root, "state") };

			const native = await says(entry, env);
			const first = await says(entry, env, startingAs22());
			const second = await says(entry, env, startingAs22());

			expect(native.transpiler, "node strips with its transpiler").toBe(true);
			expect(first).toEqual(native);
			expect(second).toEqual({ ...native, transpiler: false });
		},
		3 * ONE_RUN,
	);

	it(
		"leaves node to strip every time once turned off",
		async () => {
			const entry = await sayingModule();
			const env = {
				XDG_STATE_HOME: join(root, "state"),
				[OFF_VARIABLE]: "off",
			};

			await says(entry, env, startingAs22());
			const second = await says(entry, env, startingAs22());

			expect(second.transpiler).toBe(true);
		},
		2 * ONE_RUN,
	);

	it(
		"starts a supervisor with the cache's module, which node finds",
		async () => {
			const script = join(root, "supervisor.mjs");
			await writeFile(script, "console.log(process.argv[2]);\n");
			const { stdout } = await run(
				process.execPath,
				supervisorArguments(script, "request.json"),
				{
					env: { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: root },
					timeout: ONE_RUN,
				},
			);
			expect(stdout.trim()).toBe("request.json");
		},
		ONE_RUN,
	);
});
