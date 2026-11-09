/**
 * No extension adds a process listener in a host.
 *
 * A host runs many conversations in one process. A listener an
 * extension adds to that process (exit, a signal, an unhandled
 * rejection) hears every conversation's events and outlives the
 * conversation that added it, so one conversation's handler would act
 * for all of them, and each conversation's load would add another.
 * Whatever the process needs, the host installs once, as serveHost does
 * the stale-rejection net.
 *
 * A child node loads every extension as pi does, for two conversations
 * under a host, starts each, and reports the listeners the process
 * gained. The same child run on plain pi must gain one, or the count
 * could pass by seeing nothing.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Loaded } from "../support/every-extension.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SUPPORT = join(ROOT, "tests", "support", "every-extension.ts");
const MARK = "LOADED ";

/** The pi whose jiti the child loads through: its real folder, where pnpm keeps jiti. */
const PI = realpathSync(
	join(
		ROOT,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"package.json",
	),
);

/** jiti compiles the whole package cold in the child: give it time. */
const LOADS = { timeout: 180_000 };

const home = mkdtempSync(join(tmpdir(), "every-extension-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** An environment of the child's own, holding none of this session's. */
function sealed(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (name.startsWith("PI_") || name.startsWith("MYCELIUM_")) continue;
		if (name.startsWith("XDG_") || name === "NIRI_SOCKET") continue;
		env[name] = value;
	}
	for (const dir of ["state", "data", "cache", "config", "runtime", "tmp"])
		mkdirSync(join(home, dir), { recursive: true });
	return {
		...env,
		HOME: home,
		TMPDIR: join(home, "tmp"),
		XDG_STATE_HOME: join(home, "state"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_RUNTIME_DIR: join(home, "runtime"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		PI_NOTIFY: "off",
		PI_LAUNCHER: "off",
		PI_SETTLE: "off",
	};
}

/** Load every extension in a child node, hosted or on plain pi. */
function loadInAChild(hosted: boolean): Loaded {
	const script = `
		import { createRequire } from "node:module";
		const { createJiti } = createRequire(${JSON.stringify(PI)})("jiti");
		const jiti = createJiti(${JSON.stringify(`file://${ROOT}/`)});
		const { loadEveryExtension } = await jiti.import(${JSON.stringify(SUPPORT)});
		const loaded = await loadEveryExtension(${hosted});
		console.log(${JSON.stringify(MARK)} + JSON.stringify(loaded));
		// Extensions leave timers running; what they added is already said.
		process.exit(0);
	`;
	const output = execFileSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{ cwd: ROOT, encoding: "utf8", env: sealed(), maxBuffer: 64 * 1024 * 1024 },
	);
	const line = output
		.split("\n")
		.reverse()
		.find((one) => one.startsWith(MARK));
	if (line === undefined) throw new Error(`the child said nothing:\n${output}`);
	return JSON.parse(line.slice(MARK.length));
}

describe("process listeners", () => {
	it("are added by no extension's load or start in a host", LOADS, () => {
		const loaded = loadInAChild(true);

		expect(loaded.extensions, "every extension was found").toBeGreaterThan(40);
		// One that failed to load would add nothing, and pass unseen.
		expect(loaded.failed, "every extension loads and starts").toEqual([]);
		expect(
			loaded.added,
			"a hosted load added these; the host installs what its process needs",
		).toEqual({});
	});

	it("are seen when plain pi's load adds one", LOADS, () => {
		const loaded = loadInAChild(false);

		expect(loaded.failed, "every extension loads and starts").toEqual([]);
		expect(
			loaded.added.unhandledRejection,
			"plain pi's reload-workflow adds the stale-rejection net",
		).toBeGreaterThan(0);
	});
});
