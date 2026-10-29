/**
 * Write the launcher's restore file with no pi running, as a user
 * service does when the account's session starts: which sessions the
 * last boot's end took away (lib/internal/quest/restore-file.ts).
 *
 * Each pi rewrites the file as it starts, but until one does, the file
 * would still describe an older boot, and the launcher would offer that
 * boot's sessions. It reads only the quest workflow's session records
 * and probes no process, so it takes a moment.
 *
 * Node runs it as it stands, stripping the types:
 *
 *   node scripts/restore-file.ts
 */

import { join } from "node:path";
import { refreshRestoreFile } from "../extensions/quest-workflow/session-registry.ts";
import { dataDir } from "../lib/internal/paths.ts";

refreshRestoreFile(join(dataDir("quest-workflow"), "quests"));
