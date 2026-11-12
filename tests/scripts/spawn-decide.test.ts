/**
 * spawn-decide run as the launcher runs it, by node in an environment of
 * its own, before it opens a window for a fresh spawn: what isn't a spawn
 * stays, saying nothing, and a spawn spawnHost sends to a host that isn't
 * listening stays, saying why, with its words left for its window's pi.
 * Where a host takes it is handToHost's, in the extension's own tests, and
 * E14's on a real host.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SPAWN_STAYS } from "../../extensions/quest-workflow/launched-spawn.ts";
import { leaveFirstWords } from "../../lib/internal/quest/first-words.ts";

const SCRIPT = join(
	import.meta.dirname,
	"..",
	"..",
	"scripts",
	"spawn-decide.ts",
);
const QUEST = "QEST-20261112-DECIDE";
/** Generous for a loaded machine; the launcher itself gives it 3 s. */
const PATIENCE_MS = 30_000;

let root: string;
let runtime: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "spawn-decide-"));
	// Short, since a host's socket path has to fit a Unix socket's limit.
	runtime = mkdtempSync(join(tmpdir(), "k7d-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
});

/** The package's own folder under an XDG root of the sealed environment. */
function packageDir(kind: "config" | "state"): string {
	return join(root, kind, "pi", "agentic-harness.pi");
}

/** Run the decider on a spawn as the launcher does; answers its exit status and output. */
function decide(
	sessionId: string,
	env: Record<string, string>,
): Promise<{ code: number; out: string }> {
	return decideWith(["--session-id", sessionId], env);
}

/** Run the decider with `args` as the launcher does; answers its exit status and output. */
function decideWith(
	args: readonly string[],
	env: Record<string, string>,
): Promise<{ code: number; out: string }> {
	return new Promise((done) => {
		execFile(
			process.execPath,
			["--no-warnings", SCRIPT, ...args],
			{
				cwd: root,
				timeout: PATIENCE_MS,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: root,
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: join(root, "state"),
					XDG_RUNTIME_DIR: runtime,
					MYCELIUM_REALM: "work",
					PI_HOME_REALM: "work",
					...env,
				},
			},
			(error, stdout) =>
				done({
					code:
						error === null
							? 0
							: typeof error.code === "number"
								? error.code
								: -1,
					out: stdout,
				}),
		);
	});
}

it("stays, saying nothing, for a pi that isn't a spawn", async () => {
	expect(await decide(randomUUID(), {})).toEqual({
		code: SPAWN_STAYS,
		out: "",
	});
});

/** Write quest-workflow's config section as `section` says. */
function configure(section: Record<string, string>): void {
	mkdirSync(packageDir("config"), { recursive: true });
	writeFileSync(
		join(packageDir("config"), "config.json"),
		JSON.stringify({ version: 1, sections: { "quest-workflow": section } }),
	);
}

it("stays, saying nothing, for the launcher's own start while startHost is off", async () => {
	configure({ spawnHost: "attended" });

	expect(
		await decideWith(["--start", "--orchestrate"], {
			QUEST_WORKFLOW_AUTOLOAD_ID: QUEST,
		}),
	).toEqual({ code: SPAWN_STAYS, out: "" });
});

it("stays, saying why, for the launcher's own start when startHost's host isn't listening", async () => {
	configure({ startHost: "attended" });

	const { code, out } = await decideWith(["--start"], {
		QUEST_WORKFLOW_AUTOLOAD_ID: QUEST,
	});

	expect(code).toBe(SPAWN_STAYS);
	expect(out).toMatch(
		/^quest-workflow\.startHost is attended, but no work-attended host is listening[^\n]*\n$/,
	);
});

it("stays, saying why, with its words still waiting, when spawnHost's host isn't listening", async () => {
	const sessionId = randomUUID();
	mkdirSync(packageDir("config"), { recursive: true });
	writeFileSync(
		join(packageDir("config"), "config.json"),
		JSON.stringify({
			version: 1,
			sections: { "quest-workflow": { spawnHost: "background" } },
		}),
	);
	const words = join(packageDir("state"), "quest-workflow", "first-words");
	leaveFirstWords(sessionId, `Carry on with ${QUEST}.`, words);

	const { code, out } = await decide(sessionId, {
		QUEST_WORKFLOW_AUTOLOAD_ID: QUEST,
	});

	expect(code).toBe(SPAWN_STAYS);
	expect(out).toMatch(/^[^\n]*no work-background host is listening[^\n]*\n$/);
	expect(
		existsSync(join(words, `${sessionId}.json`)),
		"the words wait for the window's pi",
	).toBe(true);
	expect(
		readFileSync(
			join(packageDir("state"), "quest-workflow", "launched-spawns.log"),
			"utf8",
		),
	).toMatch(/stayed in its window: .* \(headless, \d+ ms\)/);
});
