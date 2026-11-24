/**
 * Keep the node told which quests this session orchestrates.
 *
 * The node routes what is sent to an orchestrator by the claims sessions
 * make, and refuses a quest another session already claims, but nothing
 * here ever made one, so its record stayed empty (WCJQSG, 23 November).
 * A session with an orchestrating quest loaded now claims it, with every
 * open quest whose nearest orchestrator it is, as it starts, after each
 * quest action, and at a turn's start whenever the loaded quest changed
 * and otherwise every few minutes, on a timer as well as at a turn, so an
 * idle orchestrator says the claim again in case the node let it lapse.
 * Between those it asks only when the claim differs from the one the node
 * last recorded, and it forgets its claim once it has no orchestrating
 * quest loaded, or once its conversation ends other than by a reload or
 * a park: a swap's successor has another id, so it can't forget for it.
 *
 * The node may hold a claim this keeper never saw: one made before a
 * reload, by the session this one continues, or sent by an ask that
 * timed out. So it starts unsure, and a session with nothing to claim
 * forgets once, which costs the node nothing when it held nothing. A
 * refusal changes nothing at the node, so a session refused one quest
 * still heads the one it claimed before, or the one an earlier session
 * claimed, which it then forgets before claiming again. An ask that may
 * have landed adds to what the node may hold rather than replacing it,
 * so a refusal after one still lets go of every quest headed before. A
 * keeper's first claim, refused, forgets what it may hold from before and
 * is asked once more at the first turn or tick from half a minute on,
 * since a swap's successor can reach the node ahead of its predecessor's
 * forget; the predecessor's end sends that forget at once, beside any ask
 * still in flight, and waits a little for it, so it mostly lands first.
 * The claim is said again a few minutes after it was last sent, however
 * many quest actions came between.
 *
 * At most one ask runs at a time and at most one waits behind it, which
 * reads the quests as they are when it runs, so a burst of quest actions,
 * or a node that hangs, costs one more ask rather than one each. An ask
 * the node refused or never answered isn't asked again until it is due,
 * each on its own wait, so the forget a refusal sends never cuts the
 * refusal's wait short however it is answered, and each trouble is said
 * once until the node next answers.
 * Every ask runs off the turn with what its hook read then, the session's
 * own environment among it, and never touches the context it was started
 * from, so a reload finds nothing stale; one in flight as the session
 * shuts down sends nothing after it, and a throw anywhere in one is said,
 * never left to end the process.
 */

import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sessionEnv } from "../../lib/core/session/index.ts";
import { discoverQuests } from "../../lib/internal/quest/discovery/discovery.ts";
import {
	orchestrates,
	questsOrchestratedBy,
} from "../../lib/internal/quest/fields/orchestration.ts";
import {
	journalCommand,
	sayInJournal,
} from "../../lib/internal/session/journal.ts";
import { isParking, PARKING } from "../../lib/internal/session/park.ts";
import { nodeSocket, realmOf } from "../../lib/mesh/node.ts";
import {
	type ClaimPlace,
	type ClaimTold,
	type OrchestrationClaim,
	tellOrchestrates,
} from "../../lib/mesh/orchestrates.ts";
import { isOpen } from "./desktop/orchestrators.ts";
import { endReasonForShutdown } from "./session-registry.ts";
import type { QuestState } from "./state.ts";
import { currentSessionId } from "./verbs/shared.ts";

/** How often a turn's start looks again, and a failed ask waits to be asked again. */
export const CLAIM_LOOKED_AGAIN_MS = 5 * 60_000;

/**
 * How often the timer asks whether a look is due. Well inside the due
 * period, so an idle claim is said again within a minute of being due
 * rather than a whole period late when a tick lands just short of it,
 * and a start's retry comes within a minute and a half of its refusal.
 */
export const CLAIM_TICK_MS = 60_000;

/**
 * How soon, at the earliest, the keeper's first claim, refused, is asked
 * once more: at the first turn or tick past it. A swap's successor claims
 * as it starts, while its predecessor's forget may still be on its way;
 * past that the refusal is the node's own word.
 */
export const CLAIM_RETRIED_AFTER_START_MS = 30_000;

/**
 * The longest a conversation's end waits for its last forget, well inside
 * the 3 s a mycelium holder gives pi before it kills it. The forget is
 * started at once, so what the cap cuts short is the wait for its answer,
 * not its sending; a forget that goes unanswered leaves the node to let
 * the claim lapse.
 */
export const CLAIM_END_WAIT_MS = 1_500;

/** What the keeper needs from outside, so a test can stand in for each. */
export interface ClaimKeeperDeps {
	/** Ask the node; `tellOrchestrates` by default. */
	readonly tell?: (
		claim: OrchestrationClaim | "forget",
		session: string,
		realm: string,
		place: ClaimPlace,
	) => Promise<ClaimTold>;
	/** The realm whose node to tell in `env`, or nothing when no node serves. */
	readonly realm?: (env: NodeJS.ProcessEnv) => string | undefined;
	/** A monotonic clock in milliseconds. */
	readonly now?: () => number;
	/** Where a refusal or a node that can't be asked is said. */
	readonly journal?: (line: string) => void;
	/**
	 * Run `look` every `ms` until the returned stop is called, never
	 * keeping the process alive; an unref'd interval by default.
	 */
	readonly every?: (look: () => void, ms: number) => () => void;
}

/** Wire the claim to the session's start, its quest actions, its turns and its end. */
export function keepOrchestrationClaimed(
	pi: ExtensionAPI,
	state: QuestState,
	deps: ClaimKeeperDeps = {},
): void {
	const keeper = claimKeeper(state, deps);
	const every = deps.every ?? unrefInterval;
	// What the last hook read, so the timer asks as the session would; a
	// plain value, never the context, which a reload leaves stale.
	let last: { session: string | undefined; place: ClaimPlace } | undefined;
	let parking: string | undefined;
	const seen = (ctx: ExtensionContext) => {
		last = { session: currentSessionId(ctx, undefined), place: placeOf(ctx) };
		return last;
	};
	pi.on("session_start", (_event, ctx) => {
		const { session, place } = seen(ctx);
		keeper.look(session, place);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "quest") return;
		const { session, place } = seen(ctx);
		keeper.look(session, place);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		const { session, place } = seen(ctx);
		keeper.lookIfDue(session, place);
	});
	const stopTimer = every(() => {
		if (last) keeper.lookIfDue(last.session, last.place);
	}, CLAIM_TICK_MS);
	pi.events?.on(PARKING, (data: unknown) => {
		if (isParking(data)) parking = data.session;
	});
	pi.on("session_shutdown", async (event, ctx) => {
		stopTimer();
		const session = currentSessionId(ctx, undefined);
		const ended = endReasonForShutdown(
			event.reason,
			session !== undefined && parking === session,
		);
		// A reload goes on as the same session, and a parked one is woken
		// by what is sent to it, so only an ended conversation lets go, and
		// pi waits a little for it, so a quit's forget is sent before it
		// exits and a swap's lands before its successor claims.
		if (ended === "quit" || ended === "swapped")
			await within(keeper.end(session, placeOf(ctx)), CLAIM_END_WAIT_MS);
		else keeper.stop();
	});
}

/** Wait for `done`, or `ms` at most, on a timer that never holds the process open. */
async function within(done: Promise<void>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
		timer.unref();
	});
	await Promise.race([done, late]);
	clearTimeout(timer);
}

/** Run `look` every `ms` on an interval that never holds the process open. */
function unrefInterval(look: () => void, ms: number): () => void {
	const timer = setInterval(look, ms);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * Where the session asks from, read while its hook runs: its own
 * environment, which in a pi host isn't the host's.
 */
function placeOf(ctx: ExtensionContext): Required<ClaimPlace> {
	return { env: sessionEnv(ctx).snapshot() };
}

/** What a claim keeper does, apart from pi's wiring. */
export interface ClaimKeeper {
	/** Claim what the loaded quest orchestrates now, if that changed. */
	look(session: string | undefined, place: ClaimPlace): void;
	/** The same once due, then saying the claim again even if unchanged. */
	lookIfDue(session: string | undefined, place: ClaimPlace): void;
	/** Ask nothing more, as the session reloads or parks. */
	stop(): void;
	/**
	 * Ask nothing more but a last forget, sent at once beside any ask in
	 * flight, under whichever session the node may hold a claim for, as the
	 * conversation ends for good; done once that forget is.
	 */
	end(session: string | undefined, place: ClaimPlace): Promise<void>;
	/** Every ask running or waiting has ended, for a test to wait on. */
	settled(): Promise<void>;
}

/**
 * What the node holds for this session, as far as the keeper knows: a
 * claim it recorded, nothing, or unsure, with the quests asks that may
 * have landed headed, and the session the first of them asked under;
 * starting unsure, before any answer, it may hold a claim from before.
 */
type Holding =
	| {
			readonly kind: "claim";
			readonly key: string;
			readonly session: string;
			readonly heads: string;
	  }
	| { readonly kind: "nothing" }
	| {
			readonly kind: "unsure";
			readonly heads: readonly string[];
			readonly session?: string;
	  };

/** The session the node may hold `holding` under, if the keeper knows it. */
function heldUnder(holding: Holding): string | undefined {
	return holding.kind === "nothing" ? undefined : holding.session;
}

/** Every quest the node may hold `holding` as heading. */
function headedIn(holding: Holding): readonly string[] {
	if (holding.kind === "claim") return [holding.heads];
	return holding.kind === "unsure" ? holding.heads : [];
}

/** One look's ask: who, from where, and whether it says the claim again. */
interface Asked {
	readonly session: string;
	readonly place: ClaimPlace;
	readonly again: boolean;
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
	let holding: Holding = { kind: "unsure", heads: [] };
	/**
	 * When each ask that failed did, so it waits until due to be asked
	 * again, apart from every other ask's wait.
	 */
	const failed = new Map<string, number>();
	/**
	 * When a claim or a forget was last sent, which it is said again a
	 * period after: a look that sends nothing, as a quest action's mostly
	 * does, puts it off no further, and a forget sends its own period on,
	 * so one failing isn't asked again each minute.
	 */
	let sentAt: number | undefined;
	/** Whether the node has answered a claim of this keeper's yet. */
	let claimAnswered = false;
	/** The troubles said since the last answer, so one that recurs is said once. */
	const saidTroubles = new Set<string>();
	/** When the first claim, refused, is asked once more. */
	let retryAt: number | undefined;
	/** The session the ask running now asks under. */
	let askingAs: string | undefined;
	let lookedAt: number | undefined;
	/** The quest loaded when it last looked, since a slow start loads late. */
	let lookedOn: string | null | undefined;
	let stopped = false;
	let running: Promise<void> | undefined;
	let waiting: Asked | undefined;
	let ending: Promise<void> | undefined;

	const say = (line: string): void => {
		if (saidTroubles.has(line)) return;
		try {
			journal(line);
			saidTroubles.add(line);
		} catch {
			// The journal couldn't be written; the next trouble tries again.
		}
	};

	const waitsOut = (key: string, again: boolean): boolean => {
		const at = failed.get(key);
		return !again && at !== undefined && now() - at < CLAIM_LOOKED_AGAIN_MS;
	};

	/**
	 * Ask the node, keeping what it answered; how it answered.
	 * A follow-up, the forget a refusal sends, leaves the refusal's wait
	 * and its said-once mark standing, however it is answered, so the
	 * refusal is neither asked nor said again before it is due.
	 */
	const put = async (
		claim: OrchestrationClaim | "forget",
		session: string,
		named: string,
		asked: Asked,
		key: string,
		followUp = false,
	): Promise<ClaimTold["kind"]> => {
		sentAt = now();
		const told = await tell(claim, session, named, asked.place);
		if (claim !== "forget" && told.kind !== "unasked") claimAnswered = true;
		if (told.kind === "recorded") {
			holding =
				claim === "forget"
					? { kind: "nothing" }
					: { kind: "claim", key, session, heads: claim.heads };
			failed.delete(key);
			if (!followUp) {
				failed.clear();
				saidTroubles.clear();
			}
			return told.kind;
		}
		failed.set(key, now());
		// What may have landed joins what the node may already hold, since
		// it may as well not have, under the session it was first held by.
		if (told.kind === "unasked" && told.mayLand) {
			const before = headedIn(holding);
			const heads =
				claim === "forget" || before.includes(claim.heads)
					? before
					: [...before, claim.heads];
			holding = {
				kind: "unsure",
				heads,
				session: heldUnder(holding) ?? session,
			};
		}
		const what =
			claim === "forget"
				? "forget its orchestration"
				: `claim ${claim.heads} and ${claim.quests.length} quests below it`;
		const how = told.kind === "refused" ? "refused" : "wasn't asked";
		say(
			`quest-workflow: session ${session} couldn't ${what}: the node ${how}, ${told.why}`,
		);
		return told.kind;
	};

	/** Forget what the node may hold, under the session that claimed it. */
	const forget = async (
		asked: Asked,
		named: string,
		followUp = false,
	): Promise<void> => {
		const under = heldUnder(holding) ?? asked.session;
		const key = JSON.stringify([under, named, "forget"]);
		if (waitsOut(key, asked.again)) return;
		await put("forget", under, named, asked, key, followUp);
	};

	const ask = async (asked: Asked): Promise<void> => {
		const named = realm(asked.place.env ?? process.env);
		if (named === undefined) return;
		const claim = claimOf(state);
		if (claim === "forget") {
			if (holding.kind !== "nothing") await forget(asked, named);
			return;
		}
		const key = JSON.stringify([asked.session, named, claim]);
		if (!asked.again && holding.kind === "claim" && holding.key === key) return;
		if (waitsOut(key, asked.again)) return;
		const before = holding;
		const first = !claimAnswered;
		const told = await put(claim, asked.session, named, asked, key);
		// An ask that may have landed is let be, or a forget could undo it;
		// it is held unsure, and the next look says it again. One that
		// finished as the session ended sends nothing more: the end's own
		// forget is already on its way, and a reload's keeper claims afresh.
		if (told !== "refused" || stopped) return;
		// A refusal leaves the node holding what it held, so a quest headed
		// before, and no longer loaded, is let go, and so is the same quest
		// held under an earlier session, which the node refuses this one for.
		const otherQuest = headedIn(before).some((heads) => heads !== claim.heads);
		const earlier = heldUnder(before);
		const otherSession = earlier !== undefined && earlier !== asked.session;
		// Once an earlier session's claim is let go this one's may stand, so
		// it is asked again at once; a refusal of another quest's is waited out.
		if (otherSession) {
			await forget(asked, named, true);
			if (holding.kind === "nothing" && !stopped)
				await put(claim, asked.session, named, asked, key);
			return;
		}
		// The first claim refused: what the node holds from before is let go,
		// and the claim asked once more soon, in case what refused it was a
		// predecessor's claim whose forget was still on its way.
		if (first) {
			if (holding.kind !== "nothing") await forget(asked, named, true);
			retryAt = now() + CLAIM_RETRIED_AFTER_START_MS;
			return;
		}
		if (otherQuest) await forget(asked, named, true);
	};

	const drain = async (first: Asked): Promise<void> => {
		let asked: Asked | undefined = first;
		while (asked && !stopped) {
			try {
				askingAs = asked.session;
				await ask(asked);
			} catch (error) {
				say(`quest-workflow: an orchestration claim failed: ${String(error)}`);
			}
			asked = waiting;
			waiting = undefined;
		}
		running = undefined;
	};

	const look = (
		session: string | undefined,
		place: ClaimPlace,
		again = false,
	): void => {
		if (!session || stopped) return;
		lookedAt = now();
		lookedOn = state.questId;
		const asked: Asked = {
			session,
			place,
			again: again || (waiting?.again ?? false),
		};
		// One ask at a time, in order, so a forget never overtakes a claim;
		// one waiting reads the quests as it runs, so it stands for them all.
		if (running) {
			waiting = asked;
			return;
		}
		running = drain(asked);
	};

	return {
		look: (session, place) => look(session, place),
		lookIfDue(session, place) {
			if (lookedAt === undefined || lookedOn !== state.questId) {
				// Another quest is claimed afresh, so a retry for the last one lapses.
				retryAt = undefined;
				look(session, place);
			} else if (retryAt !== undefined && now() >= retryAt) {
				retryAt = undefined;
				look(session, place, true);
			} else if (now() - (sentAt ?? lookedAt) >= CLAIM_LOOKED_AGAIN_MS)
				look(session, place, true);
		},
		stop() {
			stopped = true;
			waiting = undefined;
		},
		end(session, place) {
			if (stopped || !session) {
				stopped = true;
				return ending ?? Promise.resolve();
			}
			stopped = true;
			waiting = undefined;
			// Sent at once rather than behind an ask in flight, which can take
			// 20 s where a quit gives the forget a moment; one in flight may yet
			// land a claim, so the forget goes even while nothing is held.
			const inFlight = running === undefined ? undefined : askingAs;
			const last = async (): Promise<void> => {
				if (inFlight === undefined && holding.kind === "nothing") return;
				const named = realm(place.env ?? process.env);
				if (named === undefined) return;
				// Under the session the node may hold a claim for, or else the
				// one the ask in flight asks under.
				const under = inFlight ?? session;
				await forget({ session: under, place, again: true }, named);
			};
			ending = last().catch((error: unknown) => {
				say(`quest-workflow: an orchestration claim failed: ${String(error)}`);
			});
			return ending;
		},
		async settled() {
			while (running) await running;
			await ending;
		},
	};
}

/**
 * What the loaded quest orchestrates as the quests stand: the quest and
 * every open one whose nearest orchestrator it is, or `forget` when no
 * quest is loaded, or the one loaded doesn't orchestrate or has ended.
 * The node refuses only another session's heads, or a quest another
 * already lists, so a nested orchestrator listed here and headed by its
 * own session claims beside it.
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

/** The realm of the node serving `env`'s session, or nothing when none does. */
function servedRealm(env: NodeJS.ProcessEnv): string | undefined {
	const socket = nodeSocket(env);
	return socket !== undefined && existsSync(socket) ? realmOf(env) : undefined;
}

/** Write a line to the system's journal at warning. */
function warnInJournal(line: string): void {
	sayInJournal(line, journalCommand("warning"));
}
