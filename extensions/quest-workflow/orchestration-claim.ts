/**
 * Keep the node told which quests this session orchestrates.
 *
 * The node routes what is sent to an orchestrator by the claims sessions
 * make, and refuses a quest another session already claims, but nothing
 * here ever made one, so its record stayed empty (WCJQSG, 23 November).
 * A session with an orchestrating quest loaded now claims it, with every
 * open quest whose nearest orchestrator it is, as it starts, after each
 * quest action, and at a turn's start whenever the loaded quest changed
 * and otherwise at most every few minutes, since quests below it are
 * made and concluded by other sessions too. It asks
 * only when the claim differs from the one last recorded, and forgets
 * its claim once it no longer has an orchestrating quest loaded. A
 * session that ends doesn't forget: the node lapses a claim once its
 * session neither runs nor waits parked, and one that continues the
 * session takes it over.
 *
 * Every ask runs off the turn and never touches the context it was
 * started from, so a reload while one is in flight finds nothing stale.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverQuests } from "../../lib/internal/quest/discovery/discovery.ts";
import {
	orchestrates,
	questsOrchestratedBy,
} from "../../lib/internal/quest/fields/orchestration.ts";
import {
	journalCommand,
	sayInJournal,
} from "../../lib/internal/session/journal.ts";
import { nodeSocket, realmOf } from "../../lib/mesh/node.ts";
import {
	type ClaimTold,
	type OrchestrationClaim,
	tellOrchestrates,
} from "../../lib/mesh/orchestrates.ts";
import { isOpen } from "./desktop/orchestrators.ts";
import type { QuestState } from "./state.ts";
import { currentSessionId } from "./verbs/shared.ts";

/** How often a turn's start looks again for quests made or ended below. */
export const CLAIM_LOOKED_AGAIN_MS = 5 * 60_000;

/** What the keeper needs from outside, so a test can stand in for each. */
export interface ClaimKeeperDeps {
	/** Ask the node; `tellOrchestrates` by default. */
	readonly tell?: (
		claim: OrchestrationClaim | "forget",
		session: string,
		realm: string,
		cwd: string,
	) => Promise<ClaimTold>;
	/** The realm whose node to tell, or nothing when no node serves here. */
	readonly realm?: () => string | undefined;
	/** A monotonic clock in milliseconds. */
	readonly now?: () => number;
	/** Where a refusal or a node that can't be asked is said. */
	readonly journal?: (line: string) => void;
}

/** Wire the claim to the session's start, its quest actions and its turns. */
export function keepOrchestrationClaimed(
	pi: ExtensionAPI,
	state: QuestState,
	deps: ClaimKeeperDeps = {},
): void {
	const keeper = claimKeeper(state, deps);
	pi.on("session_start", (_event, ctx) => {
		keeper.look(currentSessionId(ctx, undefined), ctx.cwd);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === "quest")
			keeper.look(currentSessionId(ctx, undefined), ctx.cwd);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		keeper.lookIfDue(currentSessionId(ctx, undefined), ctx.cwd);
	});
}

/** What a claim keeper does, apart from pi's wiring. */
export interface ClaimKeeper {
	/** Claim what the loaded quest orchestrates now, if that changed. */
	look(session: string | undefined, cwd: string): void;
	/** The same, when it was last done long enough ago. */
	lookIfDue(session: string | undefined, cwd: string): void;
	/** The asks still in flight, for a test to wait on. */
	settled(): Promise<void>;
}

/** A claim keeper over `state`, asking through `deps`. */
export function claimKeeper(
	state: QuestState,
	deps: ClaimKeeperDeps = {},
): ClaimKeeper {
	const tell = deps.tell ?? tellOrchestrates;
	const realm = deps.realm ?? servedRealm;
	const now = deps.now ?? (() => performance.now());
	const journal = deps.journal ?? warnInJournal;
	/** What the node last recorded for this session, by its key. */
	let recorded: string | undefined;
	/** The last trouble said, so one that recurs is said once. */
	let saidTrouble: string | undefined;
	let lookedAt: number | undefined;
	/** The quest loaded when it last looked, since a slow start loads late. */
	let lookedOn: string | null | undefined;
	let asking: Promise<void> = Promise.resolve();

	const ask = (session: string, cwd: string): Promise<void> => {
		const named = realm();
		if (named === undefined) return Promise.resolve();
		const claim = claimOf(state);
		// Nothing claimed and nothing to claim: nothing to tell.
		if (claim === "forget" && recorded === undefined) return Promise.resolve();
		const key = JSON.stringify([session, named, claim]);
		if (key === recorded) return Promise.resolve();
		return tell(claim, session, named, cwd).then(
			(told) => {
				if (told.kind === "recorded") {
					recorded = claim === "forget" ? undefined : key;
					saidTrouble = undefined;
					return;
				}
				const what =
					claim === "forget"
						? "forget its orchestration"
						: `claim ${claim.heads} and ${claim.quests.length} quests below it`;
				const line = `quest-workflow: session ${session} couldn't ${what}: the node ${told.kind === "refused" ? "refused" : "wasn't asked"}, ${told.why}`;
				if (line !== saidTrouble) journal(line);
				saidTrouble = line;
			},
			(error: unknown) =>
				journal(
					`quest-workflow: an orchestration claim failed: ${String(error)}`,
				),
		);
	};

	const look = (session: string | undefined, cwd: string): void => {
		if (!session) return;
		lookedAt = now();
		lookedOn = state.questId;
		// One ask at a time, in order, so a forget never overtakes a claim.
		asking = asking.then(() => ask(session, cwd));
	};

	return {
		look,
		lookIfDue(session, cwd) {
			if (
				lookedAt === undefined ||
				lookedOn !== state.questId ||
				now() - lookedAt >= CLAIM_LOOKED_AGAIN_MS
			)
				look(session, cwd);
		},
		settled: () => asking,
	};
}

/**
 * What the loaded quest orchestrates as the quests stand: the quest and
 * every open one whose nearest orchestrator it is, or `forget` when no
 * quest is loaded, or the one loaded doesn't orchestrate or has ended.
 */
function claimOf(state: QuestState): OrchestrationClaim | "forget" {
	const heads = state.questId;
	if (!heads) return "forget";
	const { index } = discoverQuests(state.questsRoot);
	const read = (id: string) => index.quests.get(id)?.doc.frontMatter;
	const own = read(heads);
	// A marked quest with nothing open below it yet still heads its own
	// orchestration, so it is claimed; only an unmarked one is forgotten.
	if (!(own && isOpen(own.status) && orchestrates(own))) return "forget";
	const open = [...index.quests.entries()]
		.filter(([, entry]) => isOpen(entry.doc.frontMatter.status))
		.map(([id]) => id);
	return { heads, quests: questsOrchestratedBy(heads, open, read) };
}

/** The realm of the node serving this machine, or nothing when none does. */
function servedRealm(): string | undefined {
	const socket = nodeSocket();
	return socket !== undefined && existsSync(socket) ? realmOf() : undefined;
}

/** Write a line to the system's journal at warning. */
function warnInJournal(line: string): void {
	sayInJournal(line, journalCommand("warning"));
}
