/**
 * Point every XDG directory at a throwaway tree, for the whole unit
 * suite.
 *
 * The code under test resolves its state, data and cache directories
 * through the XDG variables, falling back to the real `~/.local` when
 * they are unset. A test that never sets them therefore reads and
 * writes the developer's own files. That stayed invisible for as long
 * as nothing on a common path wrote anything, and stopped being
 * invisible the moment loading a quest began recording a session:
 * every test that loaded one deposited a record in the real registry,
 * under a pid belonging to a vitest worker that had since exited.
 *
 * A reader would later find that process gone, correctly conclude the
 * session had died, and offer it back as a tab to restore. Which is
 * precisely the bogus-offer behaviour the registry was built to end,
 * reintroduced through the test suite.
 *
 * Overriding HOME in each file was the existing habit and is not
 * enough: it only redirects the fallback, so it silently stops
 * working for anyone who has the XDG variables set. Setting them here
 * covers every test, including the ones nobody has written yet, which
 * is the only version of this that stays fixed.
 *
 * A test that wants its own sandbox still overrides these itself; it
 * is inheriting a safe default, not losing control.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "pi-xdg-sandbox-"));

process.env.XDG_STATE_HOME = join(sandbox, "state");
process.env.XDG_DATA_HOME = join(sandbox, "data");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.XDG_CONFIG_HOME = join(sandbox, "config");

process.on("exit", () => {
	// Best effort: a worker killed outright leaves its sandbox behind
	// in the temp directory, where the OS reclaims it.
	rmSync(sandbox, { recursive: true, force: true });
});
