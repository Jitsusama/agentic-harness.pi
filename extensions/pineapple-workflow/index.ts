/**
 * Pineapple Workflow: Joel's safe word, held at the one place a model
 * can't talk past, its own tool calls.
 *
 * When someone tags Joel with "pineapple override", core's pineapple
 * reader writes a stop saying what it reaches. While one stands, this
 * refuses the writes it reaches: pushes, pull-request writes (opening,
 * editing, commenting, reviewing, merging) and, for a realm or
 * everything, switches and deploys. Reads, builds, commits and edits go
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
 * empty folder, and the clock one more each minute.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { stoppingFromOutside } from "../../lib/internal/away/state.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import type { HeadOf } from "../../lib/internal/pineapple/cover.ts";
import { asksRepos, type Parked } from "../../lib/internal/pineapple/park.ts";
import {
	describeReach,
	type Stop,
	standingStops,
	stopsFolder,
} from "../../lib/internal/pineapple/stops.ts";
import {
	type GitFacts,
	repoOfUrl,
} from "../../lib/internal/pineapple/writes.ts";
import { sessionRealmName } from "../../lib/internal/realm.ts";
import { isPersonText } from "../../lib/internal/session/driven.ts";
import { onTurnEnd } from "../../lib/internal/session/turn-end.ts";
import { senderIdentity } from "../../lib/mesh/message.ts";
import { folderTransport } from "../../lib/mesh/transport.ts";
import { type Judging, judge, questChain, questsOf } from "./enforce.ts";
import { tendHolds } from "./holding.ts";
import { createParking } from "./parking.ts";
import { dirsOf, reposOf } from "./whereabouts.ts";

const run = promisify(execFile);

/** How long a lookup may take before the guard goes on without it. */
const LOOKUP_MS = 10_000;

/** How often parked sessions look for a resume, and holds are tended. */
const CLOCK_MS = 60_000;

export default function pineappleWorkflow(pi: ExtensionAPI) {
	declareGuards(GUARDS.pineapple);
	const heads = new Map<string, Promise<string | undefined>>();
	let ctx: ExtensionContext | undefined;
	const folder = stopsFolder();
	const stops = (): Stop[] => [...standingStops(folder).stops];
	const quests = join(dataDir("quest-workflow"), "quests");
	const parking = createParking({
		stops,
		session: async (standing) => {
			const id = ctx?.sessionManager.getSessionId() ?? "";
			const cwd = ctx?.cwd ?? process.cwd();
			const asks = asksRepos(standing);
			const dirs = asks
				? dirsOf(id, cwd, join(stateDir("work"), "cut"))
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
			logBeside(folder, "would-park.jsonl", wouldPark(parked, ctx)),
	});
	const mesh = stateDir("mesh-workflow");
	const transport = folderTransport(join(mesh, "messages"));
	function tick(): void {
		void (async () => {
			try {
				await parking.tick();
				tendHolds({
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

function judging(
	session: string,
	heads: Map<string, Promise<string | undefined>>,
): Judging {
	const folder = stopsFolder();
	return {
		standing: () => standingStops(folder),
		git: gitFacts,
		headOf: cachedHead(heads),
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

function wouldPark(
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
	async repoOf(dir, remote) {
		const url = await quietly("git", ["-C", dir, "remote", "get-url", remote]);
		return url === undefined ? undefined : repoOfUrl(url);
	},
	branchOf: (dir) =>
		quietly("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"]),
};

/**
 * A pull request's branch, asked of GitHub and then Delta, once a
 * session: a branch a change comes from doesn't move while it is open.
 */
function cachedHead(heads: Map<string, Promise<string | undefined>>): HeadOf {
	return (repo, pr) => {
		if (repo === undefined) return Promise.resolve(undefined);
		const key = `${repo}#${pr}`;
		const known = heads.get(key);
		if (known) return known;
		const asked = (async () =>
			(await quietly("gh", [
				"pr",
				"view",
				String(pr),
				"-R",
				repo,
				"--json",
				"headRefName",
				"-q",
				".headRefName",
			])) ?? (await deltaHead(repo, pr)))();
		heads.set(key, asked);
		return asked;
	};
}

async function deltaHead(
	repo: string,
	pr: number,
): Promise<string | undefined> {
	const json = await quietly("dt", [
		"pr",
		"view",
		String(pr),
		"-R",
		repo,
		"--json",
	]);
	if (json === undefined) return undefined;
	try {
		const view = JSON.parse(json) as {
			head?: { ref?: unknown };
			headRefName?: unknown;
		} | null;
		const ref = view?.head?.ref ?? view?.headRefName;
		return typeof ref === "string" ? ref : undefined;
	} catch {
		// Not JSON: Delta didn't say, and the stop holds the write.
		return undefined;
	}
}

async function quietly(
	program: string,
	args: string[],
): Promise<string | undefined> {
	try {
		const { stdout } = await run(program, args, { timeout: LOOKUP_MS });
		const out = stdout.trim();
		return out === "" ? undefined : out;
	} catch {
		// Nothing to say: an unknown answer makes the stop hold the write.
		return undefined;
	}
}
