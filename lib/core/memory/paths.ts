/**
 * Where the shared memory database lives on disk.
 *
 * Deliberately one location for every adapter, not one per
 * adapter: a fact retained while working through pi should be
 * recallable when the same project is later worked on through
 * Claude Code, and the reverse. The schema lives here in core, so
 * there is exactly one schema in play regardless of which adapter
 * opens the file, pinned by whatever core version each adapter's
 * own lockfile resolves to.
 *
 * This intentionally does not reuse pi's own XDG path (which
 * scopes everything pi stores under an `agentic-harness.pi`
 * brand): that brand means "belongs to pi", and a store two
 * adapters write to belongs to neither. Pi's own memory-integration
 * extension points here instead, once it exists.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Honours XDG_STATE_HOME; falls back to ~/.local/state per the XDG spec. */
function xdgStateRoot(): string {
	const override = process.env.XDG_STATE_HOME;
	return override && override.length > 0
		? override
		: join(homedir(), ".local", "state");
}

/** The memory database path, creating its parent directory if needed. */
export async function memoryDbPath(): Promise<string> {
	const path = join(xdgStateRoot(), "agentic-harness", "memory", "memory.db");
	await mkdir(dirname(path), { recursive: true });
	return path;
}
