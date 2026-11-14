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
 * A stop the reader marks shadow refuses nothing: what it would have
 * refused is written to `$XDG_STATE_HOME/pineapple/would-refuse.jsonl`
 * for Joel to read before any stop is enforced. With no stop standing,
 * a call costs one look at an empty folder, and only a write looks.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refusalUnder } from "../../lib/guardian/apply.ts";
import { declareGuards, GUARDS } from "../../lib/internal/guardian/guards.ts";
import { dataDir, stateDir } from "../../lib/internal/paths.ts";
import type { HeadOf } from "../../lib/internal/pineapple/cover.ts";
import {
	standingStops,
	stopsFolder,
} from "../../lib/internal/pineapple/stops.ts";
import {
	type GitFacts,
	repoOfUrl,
} from "../../lib/internal/pineapple/writes.ts";
import { sessionRealmName } from "../../lib/internal/realm.ts";
import { type Judging, judge, questsOf } from "./enforce.ts";

const run = promisify(execFile);

/** How long a lookup may take before the guard goes on without it. */
const LOOKUP_MS = 10_000;

export default function pineappleWorkflow(pi: ExtensionAPI) {
	declareGuards(GUARDS.pineapple);
	const heads = new Map<string, Promise<string | undefined>>();
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
		shadowLog: join(folder, "..", "would-refuse.jsonl"),
		now: () => new Date(),
	};
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
