/**
 * The stripped-source cache in a node of its own: a module read back
 * runs as node ran it, and node loads no transpiler for it. Whatever
 * node runs this, the cache starts as it would on node 22, so the case
 * holds on the node the tests run on.
 */

import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
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
 * whatever node runs it, and failing the run should it not start. It
 * serves the package `CODE_ROOT` names, or where none is named, the
 * package the cache's own module lies in, as a host's start does.
 */
function startingAs22(): string {
	const module = pathToFileURL(
		join(import.meta.dirname, "../../../lib/internal/stripped-source.mjs"),
	).href;
	const code = [
		`import { startStrippedSourceCache } from ${JSON.stringify(module)};`,
		"const started = startStrippedSourceCache({ facts: { env: process.env,",
		'\tversion: "v22.0.0", typescript: process.features.typescript,',
		"\tsourceMaps: process.sourceMapsEnabled, hooks: true },",
		"\tpackageRoot: process.env.CODE_ROOT || undefined });",
		'if (started.state === "failed") throw new Error(started.reason);',
	].join("\n");
	return `--import=data:text/javascript,${encodeURIComponent(code)}`;
}

/**
 * A TypeScript module saying how it was loaded, in a package of its own
 * that names no type, as this one names none, so node tells its format
 * from its syntax.
 */
async function sayingModule(): Promise<string> {
	const code = join(root, "code");
	await mkdir(code);
	await writeFile(join(code, "package.json"), '{ "name": "code" }\n');
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
): Promise<{
	fn: string;
	where: string;
	transpiler: boolean;
	stderr: string;
}> {
	const { stdout, stderr } = await run(
		process.execPath,
		[
			"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
			...(hook ? [hook] : []),
			entry,
		],
		{
			env: {
				PATH: process.env.PATH,
				HOME: root,
				CODE_ROOT: join(root, "code"),
				...env,
			},
			timeout: ONE_RUN,
		},
	);
	const told: unknown = JSON.parse(stdout);
	if (
		!isRecord(told) ||
		typeof told.fn !== "string" ||
		typeof told.where !== "string" ||
		typeof told.transpiler !== "boolean"
	)
		throw new Error(`the module said ${stdout}`);
	return {
		fn: told.fn,
		where: told.where,
		transpiler: told.transpiler,
		stderr,
	};
}

/** The entries the cache keeps under `state`, with when each was read. */
async function entriesUnder(state: string): Promise<Map<string, number>> {
	const cache = join(state, "pi", "agentic-harness.pi", "stripped-source");
	const entries = new Map<string, number>();
	for (const install of await readdir(cache)) {
		for (const name of await readdir(join(cache, install))) {
			if (name === "root") continue;
			const path = join(cache, install, name);
			entries.set(path, (await stat(path)).mtimeMs);
		}
	}
	return entries;
}

/** Whether node loaded its transpiler importing the package's own `record.ts`. */
async function transpiledRecord(state: string): Promise<boolean> {
	const record = pathToFileURL(
		join(import.meta.dirname, "../../../lib/internal/record.ts"),
	).href;
	const { stdout } = await run(
		process.execPath,
		[
			startingAs22(),
			"--input-type=module",
			"--eval",
			[
				`await import(${JSON.stringify(record)});`,
				"console.log(process.moduleLoadList.some((m) => m.includes('amaro')));",
			].join("\n"),
		],
		{
			env: { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: state },
			timeout: ONE_RUN,
		},
	);
	return stdout.trim() === "true";
}

describe("the stripped-source cache in a node", () => {
	it(
		"serves the package's own modules where no package is named, marking an entry read again once a day has passed and not before",
		async () => {
			const state = join(root, ".local", "state");

			expect(await transpiledRecord(state), "the first strips").toBe(true);
			const kept = await entriesUnder(state);
			expect(kept.size, "an entry is kept").toBeGreaterThan(0);
			expect(await transpiledRecord(state), "the next reads back").toBe(false);

			// Read within the day, an entry is left as it was: a write per
			// read would cost every start a write per module.
			const hoursAgo = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000);
			for (const path of kept.keys()) await utimes(path, hoursAgo, hoursAgo);
			expect(
				await transpiledRecord(state),
				"an entry read hours ago still reads back",
			).toBe(false);
			for (const [path, read] of await entriesUnder(state))
				expect(read, `${path} is left as it was`).toBe(hoursAgo * 1000);

			const dayAndMore = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
			for (const path of kept.keys())
				await utimes(path, dayAndMore, dayAndMore);
			const before = Date.now() - 60_000;
			expect(
				await transpiledRecord(state),
				"an entry read days ago still reads back",
			).toBe(false);
			for (const [path, read] of await entriesUnder(state))
				expect(read, `${path} is marked read`).toBeGreaterThan(before);
		},
		4 * ONE_RUN,
	);

	it(
		"runs a module read back as node ran it, with no transpiler loaded",
		async () => {
			const entry = await sayingModule();
			const env = { XDG_STATE_HOME: join(root, ".local", "state") };

			const native = await says(entry, env);
			const first = await says(entry, env, startingAs22());
			const second = await says(entry, env, startingAs22());

			expect(native.transpiler, "node strips with its transpiler").toBe(true);
			expect(first.stderr, "the strip it keeps warns of nothing").not.toMatch(
				/stripTypeScriptTypes/,
			);
			expect({ ...first, stderr: "" }).toEqual({ ...native, stderr: "" });
			expect({ ...second, stderr: "" }).toEqual({
				...native,
				transpiler: false,
				stderr: "",
			});
		},
		3 * ONE_RUN,
	);

	it(
		"leaves node to strip every time once turned off",
		async () => {
			const entry = await sayingModule();
			const env = {
				XDG_STATE_HOME: join(root, ".local", "state"),
				[OFF_VARIABLE]: "off",
			};

			await says(entry, env, startingAs22());
			const second = await says(entry, env, startingAs22());

			expect(
				second.transpiler,
				"turned off, node strips the second start with its transpiler",
			).toBe(true);
		},
		2 * ONE_RUN,
	);

	it(
		"starts a supervisor with the cache's module, which node finds",
		async () => {
			const script = join(root, "supervisor.mjs");
			await writeFile(script, "console.log(process.argv[2]);\n");
			const { stdout, stderr } = await run(
				process.execPath,
				supervisorArguments(script, "request.json"),
				{
					env: {
						PATH: process.env.PATH,
						HOME: root,
						XDG_STATE_HOME: join(root, ".local", "state"),
					},
					timeout: ONE_RUN,
				},
			);
			expect(stdout.trim()).toBe("request.json");
			expect(stderr, "the cache started or stood aside").toBe("");
		},
		ONE_RUN,
	);
});
