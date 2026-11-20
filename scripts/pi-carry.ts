/**
 * pi-carry: the harness's half of carrying a quest from one of the
 * person's machines to another (`mycelium carry <quest> --to <machine>`
 * is the other half). Node runs it as it stands, stripping the types,
 * and it prints one JSON line for each thing it does:
 *
 *   node scripts/pi-carry.ts <quest> --to <machine>
 *   node scripts/pi-carry.ts arrive <quest> --from <machine> --session <id>
 *       [--by <address>|node@<machine> --why <reason>]
 *   node scripts/pi-carry.ts where <quest> --from <machine> --session <id>
 *   node scripts/pi-carry.ts fence <quest> --from <machine> --session <id>
 *   node scripts/pi-carry.ts settle <quest> --session <id>
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
 * the mycelium node passes only for a carry an orchestrator ordered, or
 * one the node of the machine it left chose (`node@<that machine>`), it
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
 * The fifth, run on the machine a session left once its arrival is
 * confirmed and its carry has passed the Carried day, lets go of each
 * worktree its done file names that holds only what went
 * (lib/internal/carry/settle.ts), ending with `{"kind": "settled"}`.
 * It exits 1, letting none go, when any holds work the carry lacks or
 * something live here stands in one, or a pi runs the session here
 * again (KP0L6A [e034b3f1], [893e1f9f]).
 *
 * Each exits 2 when it was asked wrongly. `--help` says how to ask it,
 * on stdout, before any of the person's state is read.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnExec } from "../lib/core/exec/index.ts";
import {
	parseQuestWorkflowConfig,
	QUEST_WORKFLOW_SLUG,
	resolveQuestsRoot,
} from "../lib/core/quest/config.ts";
import { createTreeMemory } from "../lib/core/work/memory.ts";
import { arrive, arrivedIn } from "../lib/internal/carry/arrive.ts";
import { sandboxAsking } from "../lib/internal/carry/fence.ts";
import {
	doneFileOf,
	handoverOf,
	readHandover,
} from "../lib/internal/carry/handover.ts";
import { asksForHelp, CARRY_HELP } from "../lib/internal/carry/help.ts";
import { takeNotes } from "../lib/internal/carry/notes.ts";
import { carriedBy, tellCarried } from "../lib/internal/carry/ordered.ts";
import { questHere, runsHere } from "../lib/internal/carry/quest-here.ts";
import { carryRest } from "../lib/internal/carry/rest.ts";
import {
	holderIn,
	type ProcessCwd,
	processCwds,
	settle,
} from "../lib/internal/carry/settle.ts";
import {
	getSection,
	loadPackageConfig,
} from "../lib/internal/config/loader.ts";
import { isMachineName, thisMachine } from "../lib/internal/machine/machine.ts";
import { dataDir, sessionsDir, stateDir } from "../lib/internal/paths.ts";
import { isId } from "../lib/internal/quest/creation/id.ts";
import { sessionRegistryDir } from "../lib/internal/quest/sessions/loaded.ts";
import { parseSessionRecord } from "../lib/internal/quest/sessions/session-registry.ts";
import { questWorkspacesRoot } from "../lib/internal/quest/workspace/workspace-root.ts";
import { isParked } from "../lib/internal/session/park.ts";
import { treeRecordDir } from "../lib/internal/work-records.ts";
import { memoryDbPath, openMemoryStore } from "../lib/memory/index.ts";
import { nodeMachine } from "../lib/mesh/steer-who.ts";

/** What pi-carry exits with when it was asked wrongly. */
const ASKED_WRONGLY = 2;

/** A session's id as a done file's name may hold it. */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function say(line: object): void {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Whether a pi on this machine runs `session` again, by its record here. */
function runsAgain(session: string): boolean {
	try {
		const record = parseSessionRecord(
			JSON.parse(
				readFileSync(join(sessionRegistryDir(), `${session}.json`), "utf8"),
			),
		);
		return record !== undefined && runsHere(record);
	} catch {
		// No record here, or none readable: no pi here has loaded it since.
		return false;
	}
}

function refuse(why: string): never {
	say({ kind: "failed", why });
	process.exit(ASKED_WRONGLY);
}

if (asksForHelp(process.argv.slice(2))) {
	process.stdout.write(CARRY_HELP);
	process.exit(0);
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

const settling = positionals[0] === "settle";
const arriving =
	positionals[0] === "arrive" ||
	positionals[0] === "where" ||
	positionals[0] === "fence";
const quest = arriving || settling ? positionals[1] : positionals[0];
if (
	quest === undefined ||
	!isId(quest) ||
	positionals.length > (arriving || settling ? 2 : 1)
) {
	refuse(
		"Say which quest: pi-carry <quest> --to <machine>, pi-carry arrive (or where, or fence) <quest> --from <machine> --session <id>, or pi-carry settle <quest> --session <id>.",
	);
}

const exec = spawnExec();
const home = homedir();
const workspaces = questWorkspacesRoot();

if (settling) {
	const { session } = values;
	if (session === undefined || !SESSION_ID.test(session)) {
		refuse("Say which session's old place to let go, with --session.");
	}
	let cwds: Promise<ProcessCwd[]> | undefined;
	const settled = await settle({
		exec,
		from: handoverOf(workspaces, quest, thisMachine()),
		session,
		home,
		runsHere: runsAgain(session),
		holderOf: (folder) =>
			holderIn(folder, {
				brokerHolds: async (tree) =>
					(await createTreeMemory(treeRecordDir()).otherHolders(tree)).length,
				// Read once a settle, since lsof on a Mac takes about a second.
				cwds: () => {
					cwds ??= processCwds(exec);
					return cwds;
				},
				self: process.pid,
			}),
		forget: (folder) => createTreeMemory(treeRecordDir()).forget(folder),
		say,
	});
	process.exit(settled ? 0 : 1);
}

if (arriving) {
	const { from, session, by, why } = values;
	if (!isMachineName(from))
		refuse("Say which machine it comes from, with --from.");
	if (session === undefined || !SESSION_ID.test(session)) {
		refuse("Say which session arrives, with --session.");
	}
	const ordered = by !== undefined || why !== undefined;
	const carrier = by === undefined ? undefined : carriedBy(by, from);
	if (carrier === undefined && nodeMachine(by ?? "") !== undefined) {
		refuse(
			`--by ${by} names a node other than node@${from}, as written: only the node of the machine it left, by the name it goes by, chooses to carry a session from there.`,
		);
	}
	if (
		ordered &&
		(carrier === undefined || why === undefined || why.trim() === "")
	) {
		refuse(
			"Say who carried it and why together, with --by <the address of the orchestrator that ordered it> or --by node@<the machine it left>, and --why <reason>, or neither.",
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
	if (whole && carrier !== undefined && why !== undefined) {
		tellCarried(stateDir("steer"), {
			session,
			from,
			by: carrier,
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
