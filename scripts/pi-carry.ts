/**
 * pi-carry: the harness's half of carrying a quest from one of the
 * person's machines to another (`mycelium carry <quest> --to <machine>`
 * is the other half). Node runs it as it stands, stripping the types,
 * and it prints one JSON line for each thing it does:
 *
 *   node scripts/pi-carry.ts <quest> --to <machine>
 *   node scripts/pi-carry.ts arrive <quest> --from <machine> --session <id>
 *
 * The first, run on the machine the quest leaves once its steered
 * sessions have carried their own, carries the rest into the quest's
 * handover: the sessions no pi runs and the trees no session holds
 * (lib/internal/carry/rest.ts). It ends with `{"kind": "done", "files"}`.
 *
 * The second, run on the machine it goes to, waits for one session's
 * done file, puts its trees in place and places its file for
 * `pi --session <id>` (lib/internal/carry/arrive.ts), ending with
 * `{"kind": "sessions", "sessions"}`. It exits 1 when a tree was refused
 * or the done file never came, so `pi-carry arrive ... && exec pi
 * --session <id>` starts nothing half arrived; and either exits 2 when
 * it was asked wrongly.
 */

import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { spawnExec } from "../lib/core/exec/index.ts";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
} from "../lib/core/quest/config.ts";
import { arrive } from "../lib/internal/carry/arrive.ts";
import { handoverOf } from "../lib/internal/carry/handover.ts";
import { questHere, runsHere } from "../lib/internal/carry/quest-here.ts";
import { carryRest } from "../lib/internal/carry/rest.ts";
import {
	getSection,
	loadPackageConfig,
} from "../lib/internal/config/loader.ts";
import { isMachineName, thisMachine } from "../lib/internal/machine.ts";
import { dataDir, sessionsDir } from "../lib/internal/paths.ts";
import { isId } from "../lib/internal/quest/id.ts";
import { sessionRegistryDir } from "../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../lib/internal/quest/workspace-root.ts";
import { isParked } from "../lib/internal/session/park.ts";
import { treeRecordDir } from "../lib/internal/work-records.ts";

/** What pi-carry exits with when it was asked wrongly. */
const ASKED_WRONGLY = 2;

/** A session's id as a done file's name may hold it. */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function say(line: object): void {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

function refuse(why: string): never {
	say({ kind: "failed", why });
	process.exit(ASKED_WRONGLY);
}

const { values, positionals } = (() => {
	try {
		return parseArgs({
			args: process.argv.slice(2),
			allowPositionals: true,
			options: {
				to: { type: "string" },
				from: { type: "string" },
				session: { type: "string" },
			},
		});
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
})();

const arriving = positionals[0] === "arrive";
const quest = arriving ? positionals[1] : positionals[0];
if (
	quest === undefined ||
	!isId(quest) ||
	positionals.length > (arriving ? 2 : 1)
) {
	refuse(
		"Say which quest: pi-carry <quest> --to <machine>, or pi-carry arrive <quest> --from <machine> --session <id>.",
	);
}

const exec = spawnExec();
const home = homedir();
const workspaces = questWorkspacesRoot();

if (arriving) {
	const { from, session } = values;
	if (!isMachineName(from))
		refuse("Say which machine it comes from, with --from.");
	if (session === undefined || !SESSION_ID.test(session)) {
		refuse("Say which session arrives, with --session.");
	}
	const whole = await arrive({
		exec,
		from: handoverOf(workspaces, quest, from),
		session,
		home,
		sessions: sessionsDir(home),
		clock: {
			now: () => Date.now(),
			sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		},
		say,
	});
	process.exit(whole ? 0 : 1);
}

const { to } = values;
if (!isMachineName(to)) refuse("Say which machine it goes to, with --to.");
if (to === thisMachine()) refuse(`${quest} is on ${to} already.`);
const config = await loadPackageConfig();
const section = config.ok
	? getSection(config.config, QUEST_WORKFLOW_SLUG, parseQuestWorkflowConfig)
	: { value: {} };
const here = questHere(
	quest,
	{
		registry: sessionRegistryDir(),
		quests: resolveQuestsRoot(section.value, dataDir("quest-workflow")),
		treeRecords: treeRecordDir(),
		sessionStore: sessionsDir(home),
	},
	{ runs: runsHere, parked: (session) => isParked(session) },
);
const whole = await carryRest({
	exec,
	into: handoverOf(workspaces, quest, thisMachine()),
	home,
	here,
	say,
});
process.exit(whole ? 0 : 1);
