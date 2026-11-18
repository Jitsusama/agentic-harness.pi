/**
 * Point the quest lock at an empty runtime folder before every test.
 *
 * A writer looks for its lock folder in `/run/user/<uid>`, which on a
 * desktop holds the session bus, so without this every suite that writes
 * a quest would lock in the developer's real runtime folder and its
 * result would hang on that folder's state. A folder with no bus and no
 * lock folder locks in each quest's `.writing`, as on the Mac; the suites
 * about the runtime folder set their own.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { useRunFolderForTests } from "../../lib/internal/quest/io.ts";

const empty = mkdtempSync(join(tmpdir(), "no-login-runtime-"));

beforeEach(() => {
	useRunFolderForTests(empty);
});
