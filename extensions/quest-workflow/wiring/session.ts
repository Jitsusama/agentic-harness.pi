/**
 * A session's life on its quest: what its start loads, records and
 * says, what a park or an ended quest does to it, and what its
 * shutdown stamps and releases. It changes when what a session leaves
 * on its quest at either end does.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hosted } from "../../../lib/core/session/host.ts";
import {
	clearDiscoveryCache,
	discoverQuests,
	signQuestsNow,
	withDiscoveryHeld,
} from "../../../lib/internal/quest/discovery/discovery.ts";
import { setJournalSession } from "../../../lib/internal/quest/fields/structural-journal.ts";
import {
	forgetDoing,
	keepDoingSaid,
} from "../../../lib/internal/quest/sessions/doing.ts";
import { formatRelativeAge } from "../../../lib/internal/quest/sessions/session-liveness.ts";
import {
	isParking,
	PARK_ASK,
	PARKING,
} from "../../../lib/internal/session/park.ts";
import { asideFor } from "../../../lib/ui/aside.ts";
import { count } from "../../../lib/ui/count.ts";
import type { BudgetKeeper } from "../budget.ts";
import {
	questHasEnded,
	refuseParkOnceEnded,
	stopWatchingForQuestEnd,
	watchForQuestEnd,
} from "../ends-with-quest.ts";
import { stopFirstTurnWatches } from "../first-turn-watch.ts";
import {
	attachCurrentSession,
	captureSessionIdentity,
	persist,
	prunePhantomSessionsOnLoaded,
	reconcileSessionMembership,
	releaseSessionOnShutdown,
	resolveStartup,
	sayFirstWords,
} from "../lifecycle.ts";
import { recentSessionHints } from "../lookup.ts";
import { sayPeersOnStartup } from "../peers.ts";
import { keepDesktopListsCurrent } from "../quest-index.ts";
import {
	endReasonForShutdown,
	followHostStamps,
	handOverSession,
	lostSessionCount,
	recordSessionEnd,
	refreshRestoreFile,
	setSignalStampSession,
	settleMoveNote,
	startedWith,
	stopHeartbeat,
	trackSession,
} from "../session-registry.ts";
import type { QuestState } from "../state.ts";
import { currentSessionId, isPersistedSession } from "../verbs/shared.ts";
import { keepQuestWeights } from "../weights.ts";
import { updateScoreboard } from "./scoreboard.ts";

/**
 * Answer the session's start, park and shutdown for its quest.
 * `stayed` is why a launched spawn stayed in this pi, said once the
 * first start has a screen.
 */
export function followSessionLife(
	pi: ExtensionAPI,
	state: QuestState,
	budgets: BudgetKeeper,
	stayed: string | undefined,
): void {
	let stayedBecause = stayed;
	/** What a spawn left this session to say, sent once start is done. */
	let firstWords: (() => void) | undefined;
	let stopHostStamp: (() => void) | undefined;
	let running: string | undefined;
	// A session parking quits to give back its memory, and its record
	// says it parked, so a boot that ends while it sleeps offers it back.
	let parking: string | undefined;

	// The start's every discovery after its first reads that walk, plus
	// its own writes (withDiscoveryHeld), rather than signing the tree again.
	pi.on("session_start", async (event, ctx) =>
		withDiscoveryHeld(() => {
			// What a start restores and records rests on the tree as it is.
			signQuestsNow(state.questsRoot);
			if (stayedBecause && ctx.hasUI) ctx.ui.notify(stayedBecause, "warning");
			stayedBecause = undefined;
			// What this session journals is its own, for its own undo.
			setJournalSession(currentSessionId(ctx, undefined));
			running = currentSessionId(ctx, undefined);
			// A park said before this start is over: it parked, or never did.
			parking = undefined;
			stopHostStamp?.();
			if (hosted()) {
				const session = currentSessionId(ctx, undefined);
				if (session)
					stopHostStamp = followHostStamps(pi.events, session, () =>
						releaseSessionOnShutdown(state, session),
					);
			}
			// Surface any layout-drift errors the discovery walk
			// found. After the canonical-layout tightening, a
			// nested QEST dir or a misplaced doc file gets recorded
			// as a DiscoveryError and skipped from the index. The
			// user needs to know those quests didn't load so they
			// can move them back into place rather than noticing
			// later that a quest "vanished."
			const { index, errors } = discoverQuests(state.questsRoot);
			// As one notice through the session's screen, never straight to
			// the terminal, which pi is drawing (lib/ui/aside.ts).
			if (errors.length > 0) {
				const preview = errors.slice(0, 5);
				const lines = [
					`[quest-workflow] discovery surfaced ${count(errors.length, "layout error")}:`,
					...preview.map((err) => `  ${err.path}: ${err.message}`),
					...(errors.length > preview.length
						? [`  and ${errors.length - preview.length} more`]
						: []),
					"Each is skipped until it is moved into the layout the quest-format skill describes.",
				];
				asideFor(ctx)(lines.join("\n"));
			}
			// From the walk just made, so it walks nothing more, and it catches
			// a priority edited by hand while no session was running.
			keepQuestWeights(state.questsRoot, index);
			void keepDesktopListsCurrent(state.questsRoot);

			// Resolve which quest to load through the one startup
			// pipeline: an explicit spawn request wins, then this
			// session's persisted history (a /reload restores the last
			// loaded quest and focused document), then the cwd for a
			// fresh session launched inside a quest or its tree.
			resolveStartup(state, pi, ctx);
			// Asked now, waited on before the first model call
			// (before_agent_start, in turns.ts).
			budgets.keep(ctx).catch(() => {
				// Nothing awaits this ask, and an unwatched rejection ends pi;
				// before_agent_start keeps again and is awaited.
			});
			// A session a spawn started sets to work on its quest by itself,
			// once start is done (resources_discover, below).
			firstWords = sayFirstWords(pi, ctx, currentSessionId(ctx, undefined));
			// Once a quest is loaded (restored, autoloaded or
			// resolved from the cwd), record this session on it so
			// the sessions frontmatter reflects where work happens.
			if (state.questId) {
				// Garbage-collect no-log phantoms here too: most reopens go
				// through this autoload/restore path rather than the explicit
				// load verb, so pruning only there would rarely fire. The
				// no-op case is cheap (it skips the write).
				prunePhantomSessionsOnLoaded(state);
				// Before attaching, which writes this process over the record.
				sayPeersOnStartup(state, pi, ctx);
				const sid = currentSessionId(ctx, undefined);
				attachCurrentSession(state, {
					id: sid,
					cwd: ctx.cwd,
					persisted: isPersistedSession(ctx),
					...captureSessionIdentity(),
				});
				// Reconcile on the launch path too, not only the explicit
				// load verb: a resumed or spawned session lands here, and
				// without this it would re-attach while still reading active
				// on a straggler quest from an earlier run.
				if (sid && isPersistedSession(ctx) && state.questId) {
					reconcileSessionMembership(state, sid, state.questId);
				}
				// Said in the log now, not first at a tool's result, so a pi ended
				// before its first call still leaves the quest for its resume.
				persist(state, pi, ctx);
			}
			// Record every tab a person could want back, quest or not, so a
			// later restart can reconstruct what was open together. Only a
			// persisted interactive session is resumable: a fan-out runs
			// without a session and a print run has no tab. The record is
			// re-dated on a heartbeat and stamped by the signal that takes the
			// tab away, since pi reports a closed tab as a quit. Best-effort.
			const sid = currentSessionId(ctx, undefined);
			if (sid && isPersistedSession(ctx) && (ctx.hasUI || hosted())) {
				trackSession(
					{
						sessionId: sid,
						cwd: ctx.cwd,
						...(state.questId ? { questId: state.questId } : {}),
						...captureSessionIdentity(),
						...startedWith(),
					},
					() => releaseSessionOnShutdown(state, sid),
				);
				settleMoveNote(sid, {
					hosted: hosted() !== undefined,
					reason: event.reason,
				});
				// Off the start path: the launcher's list of what the last boot's
				// end took away, now without this session if it was one of them.
				setImmediate(() => refreshRestoreFile(state.questsRoot)).unref();
			}
			updateScoreboard(state, ctx);
			keepDoingSaid(state, currentSessionId(ctx, undefined), ctx.ui);
			// A session on screen ends itself once its quest has ended and
			// nothing is left in it, so its window closes with it.
			if (ctx.hasUI || hosted()) watchForQuestEnd(state, ctx);
			// A passive pointer, nothing more: list the few most recently
			// active sessions so a fresh shell can see where work was without
			// probing history or loading anything. The authoritative, probed
			// view is `quest recent`.
			showSessionHint(state, ctx);
		}),
	);

	// pi asks for resources once every extension's session_start has
	// finished, so the first request carries the tool set they settled.
	pi.on("resources_discover", () => {
		const say = firstWords;
		firstWords = undefined;
		if (say) setImmediate(say);
	});

	pi.events?.on(PARKING, (data: unknown) => {
		if (isParking(data)) parking = data.session;
	});
	// One whose quest has ended ends instead, even woken to (ends-with-quest.ts).
	pi.events?.on(PARK_ASK, (data: unknown) =>
		refuseParkOnceEnded(data, running, () => questHasEnded(state)),
	);

	pi.on("session_shutdown", async (event, ctx) => {
		budgets.forget();
		stopHostStamp?.();
		stopHostStamp = undefined;
		const sid = currentSessionId(ctx, undefined);
		// Stop beating before stamping: a tick that landed afterwards
		// would touch the file again and re-date a session that has
		// already ended.
		stopHeartbeat();
		stopFirstTurnWatches();
		stopWatchingForQuestEnd();
		// End the session's registry record, but only for the reasons
		// that actually end something. A reload keeps the same session
		// running in the same process, so stamping it would date a tab
		// as closed while it is still on screen.
		const ended = endReasonForShutdown(
			event.reason,
			sid !== undefined && parking === sid,
		);
		if (sid && ended) {
			recordSessionEnd(sid, ended);
			forgetDoing(sid);
		}
		// A swap hands the process to another conversation, so a later
		// signal is no longer this session's to take: it is the
		// successor's, whose record is opened now in case its own start
		// never comes. A quit keeps following this one: pi reports a
		// signal as a quit, and the listener that runs right after this is
		// what corrects the record.
		if (ended === "swapped") {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const successor =
				sid && isPersistedSession(ctx) && ctx.hasUI && !hosted()
					? handOverSession(
							{
								sessionId: sid,
								cwd: ctx.cwd,
								...(state.questId ? { questId: state.questId } : {}),
								...(sessionFile ? { sessionFile } : {}),
								...captureSessionIdentity(),
								...startedWith(),
							},
							event.targetSessionFile,
						)
					: undefined;
			if (!successor) setSignalStampSession(undefined);
		}
		// Mark this session detached on the loaded quest so its
		// liveness reads correctly after the process exits. Only when
		// something ended, for the same reason as the record: a reload
		// keeps the session running in this process.
		if (sid && ended) releaseSessionOnShutdown(state, sid);
		// The discovery memo is the process's and outlives this code. The
		// code a reload brings may shape the index differently, so it
		// starts from an empty memo rather than reading this one.
		if (event.reason === "reload") clearDiscoveryCache();
	});
}

/** The most recent sessions the passive start hint will name. */
const SESSION_HINT_ROWS = 3;

/**
 * Show a passive, one-shot hint naming the few most recently active
 * sessions, so a fresh shell can see where work was without probing
 * history or loading anything. Reads only cheap log activity; it
 * never probes liveness, never loads a quest and never mutates a
 * record. Silent when there is nothing recent to point at.
 */
function showSessionHint(
	state: QuestState,
	ctx: { ui: { notify(message: string, level: "info"): void } },
): void {
	// Lead with what was lost. The moment restore is most needed is
	// the moment nobody thinks to run it: after a crash you are busy
	// reconstructing, not remembering which verb exists.
	const lost = lostSessionCount();
	if (lost > 0) {
		ctx.ui.notify(
			`${count(lost, "quest session")} went with a crash or a closed terminal. Run \`quest reopen-sessions\` to see them, or \`quest reopen-sessions force\` to reopen them.`,
			"info",
		);
	}
	const hints = recentSessionHints(state, SESSION_HINT_ROWS);
	if (hints.length === 0) return;
	const now = new Date();
	const lines = hints.map((h) => {
		const age = formatRelativeAge(h.lastActivity, now);
		const when = age ? ` (${age})` : "";
		const where = h.cwd ? ` ${h.cwd}` : "";
		return `- ${h.questId} ${h.title ?? ""}${where}${when}`.trimEnd();
	});
	ctx.ui.notify(
		`Recent quest sessions:\n${lines.join("\n")}\nRun \`quest recent\` for the live view.`,
		"info",
	);
}
