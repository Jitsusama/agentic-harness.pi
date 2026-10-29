/**
 * Where the shared memory database lives on disk.
 *
 * It sits under `agentic-harness`, not pi's own `agentic-harness.pi`
 * state folder, because it was once shared with a Claude Code
 * adapter. The facts already held there stay where they are, so the
 * path stays too.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realmSegments } from "../internal/realm.ts";

/** Honours XDG_STATE_HOME; falls back to ~/.local/state per the XDG spec. */
function xdgStateRoot(): string {
	const override = process.env.XDG_STATE_HOME;
	return override && override.length > 0
		? override
		: join(homedir(), ".local", "state");
}

/**
 * The memory database path, creating its parent directory if needed: the
 * session's realm's own, so a project's facts from one realm never reach
 * a session in another (see lib/internal/realm.ts).
 */
export async function memoryDbPath(): Promise<string> {
	const path = join(
		xdgStateRoot(),
		"agentic-harness",
		...realmSegments(),
		"memory",
		"memory.db",
	);
	await mkdir(dirname(path), { recursive: true });
	return path;
}
