/**
 * pi-carry: the harness's half of carrying a quest from one of the
 * person's machines to another (`mycelium carry <quest> --to <machine>`
 * is the other half). Node runs it as it stands, stripping the types,
 * and it prints one JSON line for each thing it does:
 *
 *   node scripts/pi-carry.ts <quest> --to <machine>
 *   node scripts/pi-carry.ts arrive <quest> --from <machine> --session <id>
 *       [--by <address> --why <reason>]
 *   node scripts/pi-carry.ts where <quest> --from <machine> --session <id>
 *   node scripts/pi-carry.ts fence <quest> --from <machine> --session <id>
 *
 * The first, run on the machine the quest leaves once its steered
 * sessions have carried their own, carries the rest into the quest's
 * handover: the sessions no pi runs and the trees no session holds
 * (lib/internal/carry/rest.ts). It ends with `{"kind": "done", "files"}`.
 *
 * The second, run on the machine it goes to, waits for one session's
 * done file, puts its trees in place and places its file for
 * `pi --session <id>` (lib/internal/carry/arrive.ts), ending with
 * `{"kind": "sessions", "sessions", "fence"}`, the fence naming what the
 * session ran under for the node to start it under again. It adds the
 * quest's carried notes this machine's memory lacks. Given `--by` and `--why`, which
 * the mycelium node passes only for a carry an orchestrator ordered, it
 * then tells the session, by a steer from this machine's pi-carry, who
 * carried it and why (lib/internal/carry/ordered.ts), so it never takes
 * the carry for its person's. It exits 1 when a tree was refused
 * or the done file never came, so `pi-carry arrive ... && exec pi
 * --session <id>` starts nothing half arrived.
 *
 * The third, run once the second has gone through, prints the folder
 * the session arrived in and nothing else, for the shell to enter before
 * it starts pi there: its own folder where a tree it brought holds it,
 * else its quest's scratch. It exits 1, printing nothing but a failed
 * line on stderr, when no done file names a session to arrive.
 *
 * The fourth prints what to set `PI_SANDBOX` to for the session to start
 * under the fence it ran under (`fence`, `strict`, or `off` for none),
 * or nothing when an older harness carried it without saying, since the
 * node's shell starts pi and can't read JSON (KP0L6A [ce41f2b6]). It
 * exits 1 as the third does.
 *
 * Each exits 2 when it was asked wrongly.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnExec } from "../lib/core/exec/index.ts";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
} from "../lib/core/quest/config.ts";
import { arrive, arrivedIn } from "../lib/internal/carry/arrive.ts";
import { sandboxAsking } from "../lib/internal/carry/fence.ts";
import {
	doneFileOf,
	handoverOf,
	readHandover,
} from "../lib/internal/carry/handover.ts";
import { takeNotes } from "../lib/internal/carry/notes.ts";
import { tellCarried } from "../lib/internal/carry/ordered.ts";
import { questHere, runsHere } from "../lib/internal/carry/quest-here.ts";
import { carryRest } from "../lib/internal/carry/rest.ts";
import {
	getSection,
	loadPackageConfig,
} from "../lib/internal/config/loader.ts";
import { isMachineName, thisMachine } from "../lib/internal/machine.ts";
import { dataDir, sessionsDir, stateDir } from "../lib/internal/paths.ts";
import { isId } from "../lib/internal/quest/id.ts";
import { sessionRegistryDir } from "../lib/internal/quest/loaded.ts";
import { questWorkspacesRoot } from "../lib/internal/quest/workspace-root.ts";
import { isParked } from "../lib/internal/session/park.ts";
import { treeRecordDir } from "../lib/internal/work-records.ts";
import { memoryDbPath, openMemoryStore } from "../lib/memory/index.ts";

/** What pi-carry exits with when it was asked wrongly. */
const ASKED_WRONGLY = 2;

/** A session's id as a done file's name may hold it. */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** An orchestrator's mesh address, as the node stamps an order's `by`. */
const ADDRESS = /^[A-Za-z0-9]{6,8}$/;

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
				by: { type: "string" },
				why: { type: "string" },
			},
		});
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
})();

const arriving =
	positionals[0] === "arrive" ||
	positionals[0] === "where" ||
	positionals[0] === "fence";
const quest = arriving ? positionals[1] : positionals[0];
if (
	quest === undefined ||
	!isId(quest) ||
	positionals.length > (arriving ? 2 : 1)
) {
	refuse(
		"Say which quest: pi-carry <quest> --to <machine>, or pi-carry arrive (or where, or fence) <quest> --from <machine> --session <id>.",
	);
}

const exec = spawnExec();
const home = homedir();
const workspaces = questWorkspacesRoot();

if (arriving) {
	const { from, session, by, why } = values;
	if (!isMachineName(from))
		refuse("Say which machine it comes from, with --from.");
	if (session === undefined || !SESSION_ID.test(session)) {
		refuse("Say which session arrives, with --session.");
	}
	const ordered = by !== undefined || why !== undefined;
	if (
		ordered &&
		(by === undefined ||
			!ADDRESS.test(by) ||
			why === undefined ||
			why.trim() === "")
	) {
		refuse(
			"Say who ordered the carry and why together, with --by <address> --why <reason>, or neither.",
		);
	}
	const handover = handoverOf(workspaces, quest, from);
	const scratch = join(workspaces, quest);
	const noDoneFile = (): never => {
		process.stderr.write(
			`${JSON.stringify({ kind: "failed", why: `No done file in ${handover} names session ${session} to arrive.` })}\n`,
		);
		process.exit(1);
	};
	if (positionals[0] === "where") {
		const folder = arrivedIn(handover, session, home, scratch);
		if (folder === undefined) noDoneFile();
		process.stdout.write(`${folder}\n`);
		process.exit(0);
	}
	if (positionals[0] === "fence") {
		const done = readHandover(doneFileOf(handover, session));
		if (done?.sessionFile === undefined) noDoneFile();
		if (done?.fence !== undefined) {
			process.stdout.write(`${sandboxAsking(done.fence)}\n`);
		}
		process.exit(0);
	}
	const whole = await arrive({
		exec,
		from: handover,
		session,
		home,
		scratch,
		sessions: sessionsDir(home),
		clock: {
			now: () => Date.now(),
			sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		},
		say,
		takeNotes: async (carried, notes) => {
			const store = await openMemoryStore(await memoryDbPath());
			try {
				return await takeNotes(store, carried, notes);
			} finally {
				await store.close();
			}
		},
	});
	if (whole && by !== undefined && why !== undefined) {
		tellCarried(stateDir("steer"), {
			session,
			from,
			by: by.toUpperCase(),
			why: why.trim(),
		});
	}
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
