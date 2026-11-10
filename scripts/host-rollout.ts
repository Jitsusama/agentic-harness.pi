/**
 * Say whether a host may run more than one conversation yet, and why: each
 * live pi, the harness root it said it loaded, and whether that root
 * tells hosted conversations apart (host/service/rollout.ts). It is the
 * same judgement a host makes before a second conversation, printed for
 * a person. Exits 0 when a host may, 1 when it keeps to one. Node runs
 * it as it stands, stripping the types:
 *
 *   node scripts/host-rollout.ts [<install folder>]
 *
 * Without a folder it reads the install this script runs from, as from
 * pi-packages' `current`; run from a tree, it asks for the folder.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CENSUS_COMMIT,
	harnessVerdicts,
	loadedFolderOf,
} from "../host/service/rollout.ts";
import { LOADED_FOLDER } from "../lib/internal/reload/said.ts";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function loadedDir(): string {
	const named = process.argv[2];
	if (named) return join(named, LOADED_FOLDER);
	const own = loadedFolderOf(root);
	if (own) return own;
	throw new Error(
		`${root} is not an installed version; name the install folder, as in: node scripts/host-rollout.ts ~/.local/share/pi-packages/github.com/Jitsusama/agentic-harness.pi`,
	);
}

const dir = loadedDir();
const verdicts = await harnessVerdicts({ loadedDir: dir, self: -1 });
const stale = verdicts.filter((one) => !one.current);
const lines = verdicts.map(
	({ pid, root: said, current, why }) =>
		`${current ? "ok   " : "stale"}  ${String(pid).padStart(8)}  ${said ?? "-"}  ${why}`,
);
console.log(
	[
		`${verdicts.length} live pi${verdicts.length === 1 ? "" : "s"} in ${dir}, judged against ${CENSUS_COMMIT.slice(0, 8)} (#1129):`,
		...lines,
		stale.length === 0
			? "A host may run more than one conversation."
			: `A host keeps to one conversation: ${stale.length} stale.`,
	].join("\n"),
);
process.exitCode = stale.length === 0 ? 0 : 1;
