/**
 * The batching trial: half of one orchestration's builders are told,
 * as standing context, to send independent looks in one step.
 *
 * Every request already asks for independent calls together, yet of 200
 * back-to-back one-call bash steps sampled on 11 November 2026, 80
 * could have gone out together (40%, 32% to 48%). This tries a sharper
 * line, said once, in the half of sessions whose id's second-to-last hex
 * digit is odd (the summary-ceiling trial splits on the last, so the two
 * don't mix). The rest are the control. It is read against each
 * session's own day before, since sessions differ far more from each
 * other (13.9 points of one-call share) than from themselves day to day
 * (7.5).
 *
 * A quest listed in the out file stops hearing it at its next turn, as
 * its orchestrator asked for a session whose dates slip or findings
 * rise. It lapses after its last day, and `PI_BATCHING_TRIAL=off` stops
 * it everywhere.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	registerStandingContext,
	type StandingContextWording,
} from "../../lib/prompt/index.ts";
import { orchestratorOf, readmeIn } from "./standing-rules.ts";

const LABEL = "[Habit]";

/** The line the trial half hears. */
export const BATCHING_LINE =
	"Before a step that only looks (reads a file, a log, a status, a search), list what else you'll need to look at before acting, and send all of it in that step. Wait for a result only when the next call needs it.";

/** How the habit is said, and unsaid once the session leaves the trial. */
export const BATCHING_TRIAL: StandingContextWording = {
	customType: "batching-trial",
	inPrompt: (text) => `\n\n${LABEL} ${text}`,
	changed: (text) =>
		text === null
			? `${LABEL} Now: the habit given earlier no longer applies. This supersedes it.`
			: `${LABEL} Now: ${text} This supersedes the habit given earlier.`,
};

/** Whose sessions are in the trial, and until when. */
export interface TrialPlan {
	/** The orchestrating quest whose builders take part. */
	readonly orchestration: string;
	/** Quests under it left out, as the orchestrator's own. */
	readonly except: readonly string[];
	/** Its last day, `YYYY-MM-DD` in the local zone. */
	readonly until: string;
}

/**
 * WCJQSG's builders, all but WCJQSG and 16V6F4, from Saturday 14 to
 * Monday 16 November 2026, when it is read (WCJQSG's yes of 12 November).
 */
export const BATCHING_PLAN: TrialPlan = {
	orchestration: "QEST-20261007-WCJQSG",
	except: ["QEST-20261007-WCJQSG", "QEST-20261025-16V6F4"],
	until: "2026-11-16",
};

/** What the trial reads, apart from the plan. */
export interface TrialPlaces {
	readonly questsRoot: () => string;
	/** The out file: a quest id a line. */
	readonly out: string;
	readonly session: () => string;
	readonly now: () => number;
	readonly zone?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Where the out list is kept. */
export function batchingOutFile(env: NodeJS.ProcessEnv = process.env): string {
	const state = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "mission", "trials", "batching-out");
}

/** Whether a session, by its id or its log's name, is in the trial half. */
export function inTrialHalf(session: string): boolean {
	const id = session.replace(/\.jsonl$/, "");
	const digit = Number.parseInt(id.at(-2) ?? "", 16);
	return Number.isInteger(digit) && digit % 2 === 1;
}

/**
 * The habit for a session with `quest` loaded, or null when it isn't in
 * the trial: outside the orchestration, one of its exceptions, in the
 * other half, listed out, past the last day or turned off.
 */
export function batchingTrial(
	places: TrialPlaces,
	plan: TrialPlan = BATCHING_PLAN,
): (quest: string | null) => string | null {
	const zone = places.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const out = outList(places.out);
	const under = new Map<string, boolean>();
	return (quest) => {
		if (!quest || plan.except.includes(quest)) return null;
		if ((places.env ?? process.env).PI_BATCHING_TRIAL === "off") return null;
		if (localDay(places.now(), zone) > plan.until) return null;
		if (!inTrialHalf(places.session())) return null;
		if (!under.has(quest)) {
			const by = orchestratorOf(quest, readmeIn(places.questsRoot()));
			under.set(quest, by === plan.orchestration);
		}
		if (!under.get(quest)) return null;
		return out().has(quest) ? null : BATCHING_LINE;
	};
}

/**
 * Say the habit to a session in the trial, as standing context, for the
 * quest `questId` names at each turn.
 */
export function registerBatchingTrial(
	pi: ExtensionAPI,
	questsRoot: () => string,
	questId: () => string | null,
): void {
	let session = "";
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		session = ctx.sessionManager.getSessionId();
	});
	const habitFor = batchingTrial({
		questsRoot,
		out: batchingOutFile(),
		session: () => session,
		now: Date.now,
	});
	registerStandingContext(pi, BATCHING_TRIAL, () => habitFor(questId()));
}

/** The quests listed out, read again only when the file changes. */
function outList(path: string): () => ReadonlySet<string> {
	let seen: { mtime: number | undefined; ids: ReadonlySet<string> } = {
		mtime: undefined,
		ids: new Set(),
	};
	return () => {
		const mtime = modified(path);
		if (mtime === seen.mtime) return seen.ids;
		seen = { mtime, ids: new Set(mtime === undefined ? [] : idsIn(path)) };
		return seen.ids;
	};
}

function idsIn(path: string): string[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		// Gone between the stat and the read: nobody is listed out.
		return [];
	}
}

function modified(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		// No out file yet: nobody is listed out.
		return undefined;
	}
}

function localDay(ms: number, zone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(ms);
}
