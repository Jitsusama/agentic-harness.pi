/**
 * Pineapple Workflow: Joel's safe word, held at the one place a model
 * can't talk past, its own tool calls.
 *
 * When someone tags Joel with "pineapple override", core's pineapple
 * reader writes a stop saying what it reaches. While one stands, this
 * refuses the writes it reaches: pushes, pull-request writes (opening,
 * editing, commenting, reviewing, merging) and, for a quest, a realm
 * or everything, switches, deploys and starts of more agents. Reads,
 * builds, commits and edits go
 * on, so a stop on one pull request leaves the session its other work.
 * Only Joel resumes a stop, outside pi.
 *
 * A stop wider than one change also parks the sessions it reaches (see
 * parking.ts): the turn under way finishes and nothing new starts until
 * Joel resumes it, though what he types himself still runs. And every
 * stop sends a mesh hold to the groups its work is in, renewed while it
 * stands and ended once he resumes it (see holding.ts). No agent may
 * change the stops, or run the resume, since only Joel resumes.
 *
 * A stop the reader marks shadow refuses, parks and holds nothing: what
 * it would have done is written beside its stops, to would-refuse.jsonl,
 * would-park.jsonl and would-hold.jsonl, for Joel to read before any
 * stop is enforced. With no stop standing, a call costs one look at an
 * empty folder, and the clock one more each tick.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawnExec } from "../../lib/core/exec/index.ts";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { stoppingFromOutside } from "../../lib/internal/away/state.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { sessionRealmName } from "../../lib/internal/machine/realm.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import type { HeadOf } from "../../lib/internal/pineapple/cover.ts";
import { askedHead, keptHeads } from "../../lib/internal/pineapple/heads.ts";
import { asksRepos, type Parked } from "../../lib/internal/pineapple/park.ts";
import {
	describeReach,
	type Stop,
	standingStops,
	stopsFolder,
} from "../../lib/internal/pineapple/stops.ts";
import {
	type GitFacts,
	pushedBranch,
	pushRemote,
	repoOfPushUrls,
} from "../../lib/internal/pineapple/writes.ts";
import { isPersonText } from "../../lib/internal/session/driven.ts";
import { onTurnEnd } from "../../lib/internal/session/turn-end.ts";
import { treeRecordDir } from "../../lib/internal/work-records.ts";
import { senderIdentity } from "../../lib/mesh/message.ts";
import { folderTransport } from "../../lib/mesh/transport.ts";
import { type Judging, judge, questChain, questsOf } from "./enforce.ts";
import { tendHolds } from "./holding.ts";
import { createParking } from "./parking.ts";
import { createWhereabouts, reposOf } from "./whereabouts.ts";

/**
 * How a lookup runs: never asking on a screen, and stopped with all it
 * started after ten seconds, when the guard goes on without it.
 */
const LOOKUPS = spawnExec({ timeoutMs: 10_000 });

/**
 * How often a session looks for a stop or a resume, and holds are
 * tended: often enough that Joel's stop all, which waits a minute for
 * every session to park, sees an idle one park well inside it.
 */
const CLOCK_MS = 10_000;

export default function pineappleWorkflow(pi: ExtensionAPI) {
	declareGuards(GUARDS.pineapple);
	const heads = keptHeads(askedHead(quietly));
	let ctx: ExtensionContext | undefined;
	const folder = stopsFolder();
	const stops = (): Stop[] => [...standingStops(folder).stops];
	const quests = join(dataDir("quest-workflow"), "quests");
	const whereabouts = createWhereabouts(treeRecordDir());
	const parking = createParking({
		stops,
		session: async (standing) => {
			const id = ctx?.sessionManager.getSessionId() ?? "";
			const asks = asksRepos(standing);
			// Before a session starts there is no cwd of its own, and nothing
			// running to park, so it is nowhere.
			const cwd = ctx?.cwd;
			const dirs =
				cwd === undefined
					? []
					: asks
						? await whereabouts.dirsOf(id, cwd)
						: [cwd];
			return {
				realm: sessionRealmName(),
				quests: questsOf(
					id,
					join(stateDir("quest-workflow"), "sessions"),
					quests,
				),
				repos: asks
					? await reposOf(dirs, (dir) => gitFacts.repoOf(dir, "origin"))
					: [],
				dirs,
			};
		},
		idle: () => ctx?.isIdle?.() ?? true,
		abort: () => {
			// Stopped from outside, not by the person: away mode stays on.
			if (!ctx) return;
			stoppingFromOutside(ctx);
			ctx.abort?.();
		},
		carryOn: (text) => pi.sendUserMessage(text),
		notify: (text) => {
			if (ctx?.hasUI) ctx.ui.notify(text, "warning");
		},
		wouldPark: (parked) =>
			logBeside(folder, "would-park.jsonl", parkLine(parked, ctx)),
		parked: (parked) =>
			logBeside(folder, "parked.jsonl", parkLine(parked, ctx)),
	});
	const mesh = stateDir("mesh-workflow");
	const transport = folderTransport(join(mesh, "messages"));
	function tick(): void {
		void (async () => {
			try {
				await parking.tick();
				await tendHolds({
					stops,
					notes: join(mesh, "pineapple"),
					send: (draft) => transport.send(draft),
					shadowLog: join(dirname(folder), "would-hold.jsonl"),
					realm: sessionRealmName(),
					chainOf: (quest) => questChain(quest, quests),
					pid: senderIdentity().pid,
					now: Date.now,
				});
			} catch {
				// A clock tick that failed (a folder gone, a mesh being moved)
				// is tried again at the next; the write guard holds meanwhile.
			}
		})();
	}
	let clock: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", async (_event, started) => {
		ctx = started;
		if (clock === undefined) {
			clock = setInterval(tick, CLOCK_MS);
			clock.unref?.();
		}
		tick();
	});
	pi.on("session_shutdown", async () => {
		if (clock !== undefined) clearInterval(clock);
		clock = undefined;
	});
	pi.on("input", async (event) => {
		// What Joel types runs, stop or no stop, wherever he typed it; what
		// the harness says carries its header, whatever its source, and a
		// peer's message starts a run with no input at all.
		parking.heard(isPersonText(event.text));
		return { action: "continue" };
	});
	pi.on("agent_start", async (_event, started) => {
		ctx = started;
		await parking.started();
	});
	onTurnEnd(pi, async () => {
		await parking.turnEnded();
	});
	pi.on("tool_call", async (event, ctx) => {
		const session = ctx.sessionManager.getSessionId();
		const verdict = await judge(
			{ tool: event.toolName, input: event.input, cwd: ctx.cwd, session },
			judging(session, heads),
		);
		return refusalUnder(
			GUARDS.pineapple.name,
			verdict ? { block: true, reason: verdict.refuse } : undefined,
			"Joel's safe word",
			JSON.stringify(event.input),
		);
	});
}

function judging(session: string, heads: HeadOf): Judging {
	const folder = stopsFolder();
	return {
		standing: () => standingStops(folder),
		git: gitFacts,
		headOf: heads,
		here: () => ({
			realm: sessionRealmName(),
			quests: questsOf(
				session,
				join(stateDir("quest-workflow"), "sessions"),
				join(dataDir("quest-workflow"), "quests"),
			),
		}),
		trees: join(stateDir("work"), "trees"),
		shadowLog: join(dirname(folder), "would-refuse.jsonl"),
		records: dirname(folder),
		now: () => new Date(),
	};
}

function parkLine(
	parked: Parked,
	ctx: ExtensionContext | undefined,
): Record<string, unknown> {
	return {
		at: new Date().toISOString(),
		stop: parked.stop.id,
		session: ctx?.sessionManager.getSessionId(),
		cwd: ctx?.cwd,
		reach: describeReach(parked.reach),
		because: parked.because,
	};
}

function logBeside(
	stops: string,
	name: string,
	line: Record<string, unknown>,
): void {
	try {
		mkdirSync(dirname(stops), { recursive: true });
		writeFileSync(join(dirname(stops), name), `${JSON.stringify(line)}\n`, {
			flag: "a",
		});
	} catch {
		// A shadow log that can't be written loses one line; nothing is
		// enforced from it, and the stop itself is unchanged.
	}
}

const gitFacts: GitFacts = {
	// Where a push goes, which a remote's pushurl can send elsewhere than
	// it fetches from.
	async repoOf(dir, remote) {
		const urls = await quietly("git", [
			"-C",
			dir,
			"remote",
			"get-url",
			"--push",
			"--all",
			remote,
		]);
		return urls === undefined ? undefined : repoOfPushUrls(urls);
	},
	branchOf: (dir) =>
		quietly("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]),
	async pushRemoteOf(dir) {
		const branch = await gitFacts.branchOf(dir);
		return pushRemote(branch, config(dir));
	},
	async pushedOf(dir, remote) {
		const branch = await gitFacts.branchOf(dir);
		return pushedBranch(branch, remote, config(dir));
	},
};

/** One key of the git config of the checkout at `dir`, if it's set. */
function config(dir: string): (key: string) => Promise<string | undefined> {
	return (key) => quietly("git", ["-C", dir, "config", "--get", key]);
}

/**
 * What `program` prints, or nothing where it failed or said nothing: an
 * unknown answer makes the stop hold the write.
 */
async function quietly(
	program: string,
	args: string[],
): Promise<string | undefined> {
	const { code, stdout } = await LOOKUPS(program, args);
	const out = stdout.trim();
	return code === 0 && out !== "" ? out : undefined;
}
