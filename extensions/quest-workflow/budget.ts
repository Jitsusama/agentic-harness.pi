/**
 * The loaded quest's budget, laid over this session's environment.
 *
 * Quest-workflow hosts the budget providers (lib/budget/host.ts), since
 * it is what knows which quest a session is on. When the session
 * starts and after every quest action, it works out the budget the
 * loaded quest draws on (its own, or its nearest ancestor's), asks
 * the providers what that name means and lays the answer over
 * the session's environment, putting back what was there when the quest draws on
 * none or the session puts it down. A session on no quest draws on the
 * budget its folder's work draws on, else on one a sure judgement of
 * its folder and first prompt names, asked before that prompt's model
 * call and said to the person either way it is named. Model providers read their keys
 * from the environment as each request is made, so the next request
 * draws on it; commands and subagents started afterwards inherit it.
 * A session started for another quest does not: the terminal it opens
 * in is handed the environment without a budget on it
 * (lib/core/internal/terminal/drivers/shared.ts), and that session
 * draws on its own quest's.
 *
 * A name no provider knows, or one a provider cannot draw on now,
 * leaves the session on its default, or on the budget it was started
 * on, and says so in three places, each
 * naming the budget and what's missing: a notice, once a name; a
 * warning in the system's journal; and the session's log, whose entry
 * draws a line in the session and lets spend-watch count the sessions
 * that fell to the person's key against their quest's word. A provider
 * that fails or is late saying a folder's budget is journalled too,
 * since a quest it leaves unnamed draws on that key as well. What a
 * provider says goes into the journal and the log quoted and cut short
 * (`quoted`), so a program's stderr can't add lines or fill either. The
 * session's log says the budget drawn on (lib/budget/record.ts) each
 * time it changes, so whatever prices the log knows whose money each
 * request spent, and the bus says it each time it settles, for
 * spend-workflow's footer item, which tells it with its standing. Nothing of it goes
 * into the prompt: what a session bills is the person's to see, not
 * the model's to reason about.
 *
 * Long because the keeper is one closure whose state (the name wanted,
 * when it was missed, a capped key's hour, what a session on no quest
 * judged) every path through it reads and writes, and the helpers below
 * it serve only that closure; the folder this sits in holds as many
 * entries as it may, so a split would only move the length elsewhere.
 */

import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CAP_MOVE_LASTS_MS, onBudgetCapped } from "../../lib/budget/capped.ts";
import {
	layBudget,
	layOptedOut,
	liftBudget,
	processOverlay,
	setAsideOptedOut,
} from "../../lib/budget/environment.ts";
import {
	type BudgetDrawing,
	type FolderBudget,
	hostBudgets,
	type WorkBudget,
} from "../../lib/budget/host.ts";
import {
	type Classify,
	isBudgetName,
	type WorkToBudget,
} from "../../lib/budget/provider.ts";
import {
	BUDGET_ENTRY,
	BUDGET_OPTED_OUT_VARIABLE,
	BUDGET_SETTLED,
	BUDGET_VARIABLE,
	type BudgetRecord,
	type BudgetSettled,
	budgetDrawnOn,
	budgetKeysOf,
	lastRecordOn,
	recordIn,
	type UnresolvedBudget,
} from "../../lib/budget/record.ts";
import { findClassifier } from "../../lib/classifier/jev.ts";
import {
	type SessionContext,
	sessionEnv,
} from "../../lib/core/session/index.ts";
import { isSpawnedText, startWordsOf } from "../../lib/internal/automated.ts";
import {
	budgetFoundInRecord,
	budgetInRecord,
	NO_BUDGET,
} from "../../lib/internal/quest/fields/budget.ts";
import { isRecord } from "../../lib/internal/record.ts";
import { isPersonText, userTextOf } from "../../lib/internal/session/driven.ts";
import {
	journalCommand,
	sayInJournal,
} from "../../lib/internal/session/journal.ts";
import { SESSION_KEY } from "./lifecycle.ts";
import type { QuestState } from "./state.ts";

/** What keeps the session on its quest's budget. */
export interface BudgetKeeper {
	/**
	 * Draw on the budget the loaded quest names, if it changed. With
	 * `again`, ask the providers even when it didn't: naming a budget
	 * once more is how a person takes up one whose file they just wrote.
	 * A session on no quest draws on what its folder names, else, once it
	 * has a `prompt`, on what a sure judgement of its folder and that
	 * first prompt names; each is asked once a session.
	 */
	keep(
		ctx: ExtensionContext,
		options?: { again?: boolean; prompt?: string },
	): Promise<void>;
	/**
	 * The session has ended or been replaced: forget its context, so an
	 * answer still on its way acts for nothing. A provider has seconds to
	 * answer and the ask at start is awaited by nobody, so a reload or a
	 * rollover can land in between; the context then throws on every
	 * read, and the environment is the next load's. A later `keep` takes
	 * a session up again.
	 */
	forget(): void;
}

/**
 * The providers' answer to which budget a folder's work draws on, by
 * the quest state whose keeper hosts them, so a verb asks without the
 * keeper threaded through every call.
 */
const folderBudgets = new WeakMap<
	QuestState,
	(folder: string) => Promise<FolderBudget | undefined>
>();

/**
 * The budget the providers say work in `folder` draws on, or undefined
 * when none names one or no keeper hosts them for `state`.
 */
export function budgetOfFolder(
	state: QuestState,
	folder: string,
): Promise<FolderBudget | undefined> {
	return folderBudgets.get(state)?.(folder) ?? Promise.resolve(undefined);
}

/**
 * The providers' judgement of which budget some work draws on, by the
 * quest state whose keeper hosts them, as {@link folderBudgets} is.
 */
const workBudgets = new WeakMap<
	QuestState,
	(
		work: WorkToBudget,
		ctx: Pick<ExtensionContext, "modelRegistry">,
		signal?: AbortSignal,
	) => Promise<WorkBudget | undefined>
>();

/** The most of a first prompt a judgement is handed. */
const LONGEST_PROMPT = 1500;

/**
 * The environment variable naming the classifier budgets are judged
 * with, as `provider/model`, or `off` for none.
 */
export const BUDGET_CLASSIFIER_ENV = "PI_BUDGET_CLASSIFIER";

/**
 * The budget the providers judge `work` draws on, with the session's
 * classifier, or undefined when none judges it or no keeper hosts them.
 */
export function budgetOfWork(
	state: QuestState,
	work: WorkToBudget,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	signal?: AbortSignal,
): Promise<WorkBudget | undefined> {
	return (
		workBudgets.get(state)?.(work, ctx, signal) ?? Promise.resolve(undefined)
	);
}

/**
 * The session's classifier, found through its model registry, or one
 * that fails saying why there is none, so a provider that needs it is
 * passed over rather than every provider going unasked. `choice` is the
 * session's {@link BUDGET_CLASSIFIER_ENV}, read from its own environment,
 * which in a hosted conversation is not the host's.
 *
 * Looked up only when a provider first classifies, so the lookup is held
 * to that provider's deadline and stop, and costs nothing where no
 * provider judges: a registry slow to answer could otherwise hold a
 * first prompt past every bound.
 */
export function classifierOf(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	choice: string | undefined,
): Classify {
	const failing =
		(reason: string): Classify =>
		() =>
			Promise.reject(new Error(reason));
	const lookUp = async (): Promise<Classify> => {
		try {
			const found = await findClassifier(ctx, choice, BUDGET_CLASSIFIER_ENV);
			return found.ok ? found.classify : failing(found.reason);
		} catch (error) {
			// A registry that throws is no classifier, said as one: a create
			// or keep that awaited it would otherwise fail over a judgement.
			return failing(error instanceof Error ? error.message : String(error));
		}
	};
	let found: Promise<Classify> | undefined;
	return (context, signal) => {
		found ??= lookUp();
		return found.then((classify) => classify(context, signal));
	};
}

/** Whether a context says which conversation it is. */
function isSessionContext(ctx: unknown): ctx is SessionContext {
	return (
		isRecord(ctx) &&
		isRecord(ctx.sessionManager) &&
		typeof ctx.sessionManager.getSessionId === "function"
	);
}

/**
 * The budget a session draws on now, from its own environment: null for
 * the person's own key. A judgement its classifier makes bills this.
 */
export function budgetOfSession(ctx: unknown): string | null {
	try {
		return budgetDrawnOn(
			sessionEnv(isSessionContext(ctx) ? ctx : undefined).snapshot(),
		);
	} catch {
		// As for the classifier's choice below: the host's is the nearest word.
		return budgetDrawnOn(process.env);
	}
}

/** The classifier choice a session's own environment makes, if any. */
function classifierChoiceOf(ctx: unknown): string | undefined {
	try {
		return sessionEnv(isSessionContext(ctx) ? ctx : undefined).get(
			BUDGET_CLASSIFIER_ENV,
		);
	} catch {
		// A hosted call that names no session has no environment of its
		// own to read; the host's is the nearest word on the choice.
		return process.env[BUDGET_CLASSIFIER_ENV];
	}
}

/** Where a keeper says what went wrong; the system's journal unless a test says. */
export interface BudgetKeeperOptions {
	readonly journal?: (line: string) => void;
	/** The clock a missed budget's wait is read on; the machine's unless a test says. */
	readonly now?: () => number;
	/**
	 * The clock a capped key's hour is read on, the machine's wall clock
	 * unless a test says, since a cap lifts by the calendar and a laptop
	 * asleep stops the monotonic one.
	 */
	readonly wallNow?: () => number;
	/**
	 * The budget named for a session whose own key the cap refuses, read
	 * as it refuses, or why it can't be read; none moves such a session
	 * nowhere.
	 */
	readonly whenCapped?: () => Promise<{ name?: string; unreadable?: string }>;
	/** How long a provider may take to answer (lib/budget/host.ts's default). */
	readonly answerDeadlineMs?: number;
}

/** How long a session the cap moved stays on its budget (capped.ts). */
export const CAPPED_HOLD_MS = CAP_MOVE_LASTS_MS;

/** The budget a session on no quest draws on, and whether a judgement named it. */
interface Loose {
	readonly name: string | null;
	readonly judged: boolean;
}

/** A session on no quest that draws on no budget. */
const UNNAMED: Loose = { name: null, judged: false };

/** How a keep settles the name it asked for. */
interface Settling {
	/** The quest's own word, or one above it, is none. */
	readonly optedOut: boolean;
	/** The name was missed before, so a miss waits longer. */
	readonly retrying: boolean;
	/** What calls draw on changed though the name didn't. */
	readonly changed: boolean;
	/** A judgement of the session's folder and first prompt named it. */
	readonly judged: boolean;
	/** A quest's own word names it, standing over a none inherited. */
	readonly questsOwn: boolean;
}

/**
 * How long a budget that couldn't be drawn on waits, once a retry has
 * missed it too, before the next keep asks for it again. A provider can
 * miss once and answer the next time, as its credential program does
 * under the load of a restart, and a session that never asked again drew
 * on the default for the rest of its life. So the first miss is asked
 * again at the very next keep, since a restart's load has mostly passed
 * by then and every call before it bills the default; each miss after
 * that doubles the wait from this, up to `BUDGET_ASKED_AGAIN_MOST_MS`,
 * so a provider that stays down, or one that prompts to unlock, costs a
 * turn its deadline ever more rarely.
 */
export const BUDGET_ASKED_AGAIN_MS = 60_000;

/** The longest a missed budget waits before it is asked for again. */
export const BUDGET_ASKED_AGAIN_MOST_MS = 16 * 60_000;

/** Write a line to the system's journal at warning. */
function warnInJournal(line: string): void {
	sayInJournal(line, journalCommand("warning"));
}

/** Host budget providers and keep the session on its quest's budget. */
export function keepQuestBudget(
	pi: ExtensionAPI,
	state: QuestState,
	options: BudgetKeeperOptions = {},
): BudgetKeeper {
	const sink = options.journal ?? warnInJournal;
	// A monotonic clock, so a wall clock stepped back holds no retry off.
	const now = options.now ?? (() => performance.now());
	const wallNow = options.wallNow ?? Date.now;
	const journal = (line: string): void => {
		try {
			sink(line);
		} catch {
			// One line of news is lost; the budget it was about stands as laid.
		}
	};
	const host = hostBudgets(pi.events, options.answerDeadlineMs, (trouble) =>
		journal(
			`budget provider ${JSON.stringify(trouble.provider)} couldn't say which budget ${JSON.stringify(trouble.folder)} draws on, so its answer is passed over: ${quoted(trouble.why)}`,
		),
	);
	folderBudgets.set(state, (folder) => host.budgetFor(folder));
	workBudgets.set(state, async (work, ctx, signal) =>
		host.budgetForWork(
			work,
			classifierOf(ctx, classifierChoiceOf(ctx)),
			signal,
		),
	);
	/** The name last drawn on or asked for, null for none. */
	let wanted: string | null | undefined;
	/** Whether that none was the quest's own word, laid for what it starts. */
	let wantedOptedOut = false;
	/** Whether that name was a quest's own word, over a none inherited. */
	let wantedQuestsOwn = false;
	/** Whether this session has been on a quest, whose words its own aren't. */
	let beenOnQuest = false;
	/** Whether its record has been read for a budget judged before a reload. */
	let judgedRead = false;
	/** Bumped on every ask, so an answer overtaken by another is dropped. */
	let asking = 0;
	/** Names already said to be undrawable, so each is said once. */
	const told = new Set<string>();
	let last: ExtensionContext | undefined;
	/** The ask still on its way, so a second keep can wait on it. */
	let pending: Promise<void> = Promise.resolve();
	/** When the name wanted was last missed, so a later keep asks again. */
	let missedAt: number | undefined;
	/** How long the name wanted waits since its last miss: none at first. */
	let missedWait = 0;
	/** The budget laid for a capped key, and when, while it holds. */
	let capped:
		| {
				readonly name: string;
				readonly label: string;
				readonly env: Readonly<Record<string, string>>;
				readonly at: number;
		  }
		| undefined;
	/** Whether the session was told its capped key moved it, said once. */
	let saidCapped = false;

	/** Lay the capped key's budget again, while its hour holds. */
	const layCapped = (ctx: ExtensionContext): boolean => {
		if (!capped) return false;
		if (wallNow() - capped.at >= CAPPED_HOLD_MS) {
			capped = undefined;
			return false;
		}
		layBudget(sessionEnv(ctx), capped, processOverlay(ctx));
		return true;
	};

	/** What a session on no quest asked of its folder, once a session. */
	let folderAsked: Promise<string | null> | undefined;
	/** What it asked of its first prompt, once a session. */
	let promptAsked: Promise<string | null> | undefined;
	/** What that judgement named, once it has answered. */
	let promptNamed: string | null | undefined;
	/** Whether a keep asked to draw again, so one overtaking it does. */
	let redrawOwed = false;
	/**
	 * Its first prompt, kept so a provider registering late, or a keeper
	 * reloaded, judges the same words rather than whatever comes next.
	 */
	let firstPrompt: string | undefined;
	/**
	 * The budget the session was started on, read at its first keep and
	 * "" for none: a subagent started under its parent's quest budget
	 * keeps that one rather than taking its folder's or being judged on
	 * its task.
	 */
	let startedOn: string | undefined;
	/** Bumped as a session is forgotten, so its asks lay nothing after. */
	let sessions = 0;

	/**
	 * The budget a session on no quest draws on: its folder's, else a
	 * sure judgement's of its folder and first prompt, or null for none;
	 * and whether a judgement named it.
	 */
	const looseName = async (
		ctx: ExtensionContext,
		prompt: string | undefined,
	): Promise<Loose> => {
		if (typeof ctx.cwd !== "string" || ctx.cwd === "") return UNNAMED;
		if (startedOn) return UNNAMED;
		const folder = resolve(ctx.cwd);
		// The session this ask is for: once forgotten, its answer is no
		// longer the next session's to keep or to say.
		const session = sessions;
		folderAsked ??= host.budgetFor(folder).then((taken) => {
			if (!taken || session !== sessions) return null;
			// Said once, not again as a late provider has it asked anew; nor
			// once a quest has loaded, when the session is on one after all.
			if (taken.name === wanted || state.questId) return taken.name;
			ctx.ui.notify(
				`This session is on no quest, so it draws on budget ${taken.name}, which ${JSON.stringify(taken.provider)} says work in ${JSON.stringify(folder)} draws on.`,
				"info",
			);
			return taken.name;
		});
		const byFolder = await folderAsked;
		if (session !== sessions) return UNNAMED;
		if (byFolder !== null) return { name: byFolder, judged: false };
		// Only a person's session is judged on its prompt: a subagent or a
		// job runs in print or JSON mode, and its task is no word on whose
		// work it is, so it keeps what it inherited or its folder's, unasked
		// and unpaid. A hosted conversation is bound as RPC with no screen,
		// so pi says it has no UI; its mode is what tells it from a job.
		if (ctx.mode === "print" || ctx.mode === "json") return UNNAMED;
		firstPrompt ??=
			firstPromptOf(ctx) ?? (prompt === undefined ? undefined : askOf(prompt));
		if (firstPrompt === undefined) return UNNAMED;
		// A keeper reloaded into a conversation keeps the budget the one
		// before it was judged onto, rather than paying to judge again,
		// which a miss or an unsure answer would take off without a word.
		// Read before the quest check, since a session judged and then on
		// a quest went back to that budget as it left. Only a judgement's:
		// a folder's answer was asked afresh above. Read once a session,
		// whenever it first goes loose: one reloaded on a quest settles
		// that quest's budget first, and goes back to its judged one as it
		// leaves.
		if (promptAsked === undefined && !judgedRead) {
			judgedRead = true;
			// One it missed names what it wanted, not what calls fell to.
			const last = lastJudgedOn(branchOf(ctx));
			const missed = last?.unresolved?.budget;
			const recorded =
				missed !== undefined && isBudgetName(missed) ? missed : last?.name;
			if (typeof recorded === "string" && firstPromptOf(ctx) !== undefined) {
				promptNamed = recorded;
				promptAsked = Promise.resolve(recorded);
			}
		}
		// A session that left a quest opened on that quest's work, so its
		// first words would judge the quest's budget onto what comes next.
		if (promptAsked === undefined && (beenOnQuest || wasOnQuest(ctx)))
			return UNNAMED;
		// Started only with a run to stop it, so Escape can end the wait: a
		// keep at a session's start has none, and the prompt's keep asks.
		if (promptAsked === undefined && prompt === undefined && !ctx.signal)
			return UNNAMED;
		promptAsked ??= judgeLoose(ctx, folder, firstPrompt, session);
		const asked = promptAsked;
		const byPrompt = await asked;
		if (session !== sessions) return UNNAMED;
		if (asked === promptAsked) promptNamed = byPrompt;
		return { name: byPrompt, judged: byPrompt !== null };
	};

	const judgeLoose = async (
		ctx: ExtensionContext,
		folder: string,
		prompt: string,
		session: number,
	): Promise<string | null> => {
		// Read once: the context answers with whichever run is current when
		// asked, and Escape means this run's, not one started since.
		const run = ctx.signal;
		const judged = await host.budgetForWork(
			{ title: folder, folder, prompt: prompt.slice(0, LONGEST_PROMPT) },
			classifierOf(ctx, classifierChoiceOf(ctx)),
			// Pressing Escape stops the wait before the first model call.
			run,
		);
		if (session !== sessions) return null;
		// A judgement stopped by Escape is no answer: the next prompt asks
		// again, of the same first words.
		if (run?.aborted) {
			promptAsked = undefined;
			return null;
		}
		if (!judged?.sure || judged.name === NO_BUDGET) return null;
		// A quest loaded while it was judged settles its own budget, so the
		// session is on no quest no longer.
		if (judged.name === wanted || state.questId) return judged.name;
		ctx.ui.notify(
			`This session is on no quest, so it draws on budget ${judged.name}, which ${JSON.stringify(judged.provider)} judged from its folder and first prompt${judged.why ? `: ${judged.why}` : ""}.`,
			"info",
		);
		return judged.name;
	};

	const keep = async (
		ctx: ExtensionContext,
		again = false,
		prompt?: string,
	) => {
		last = ctx;
		if (again) redrawOwed = true;
		startedOn ??= inheritedBudget(ctx);
		if (state.questId) beenOnQuest = true;
		const found = state.questId
			? budgetInRecord(state.questsRoot, state.questId)
			: undefined;
		const loose = state.questId ? undefined : await looseName(ctx, prompt);
		const name = loose ? loose.name : (found?.name ?? null);
		// A quest loaded while a loose answer was on its way settled its own
		// budget, whether or not pi handed that keep this very context.
		if (ctx !== last || (loose && state.questId)) return pending;
		// A quest whose own word, or one above it, is none, as against one
		// nothing names: what it starts keeps to that word.
		const optedOut = found !== undefined && found.name === null;
		const due = missedAt !== undefined && now() - missedAt >= missedWait;
		// Its hour out, a capped key is drawn on again, so settle afresh.
		const cappedOut =
			capped !== undefined && wallNow() - capped.at >= CAPPED_HOLD_MS;
		if (cappedOut) capped = undefined;
		// A walk that couldn't read a README on the way heard no word, so
		// it keeps to a none the session was started under.
		const unread =
			state.questId !== null &&
			found === undefined &&
			budgetFoundInRecord(state.questsRoot, state.questId) === "unread";
		const questsOwn = !loose && !optedOut && !unread;
		// Leaving a quest that named nothing changes whose word stands, so
		// a none it set aside comes back, though the name is still none.
		const same =
			name === wanted &&
			optedOut === wantedOptedOut &&
			questsOwn === wantedQuestsOwn;
		if (same && !redrawOwed && !due && !cappedOut) return pending;
		// Due or not, a name missed before is a retry, so a capped key's hour
		// running out doesn't start its backoff afresh.
		const retrying = same && !redrawOwed && missedAt !== undefined;
		redrawOwed = false;
		wanted = name;
		wantedOptedOut = optedOut;
		wantedQuestsOwn = questsOwn;
		missedAt = undefined;
		const ask = ++asking;
		// The hour out changes what calls draw on, so it is recorded even
		// when the miss is the same as before.
		pending = settle(ctx, name, ask, {
			optedOut,
			retrying,
			changed: cappedOut,
			judged: loose?.judged ?? false,
			questsOwn,
		});
		return pending;
	};

	const settle = async (
		ctx: ExtensionContext,
		name: string | null,
		ask: number,
		how: Settling,
	) => {
		const { optedOut, retrying, changed, judged } = how;
		// A quest's own word stands over a none the session was started
		// under, so what it starts doesn't keep to that none.
		const ownWord = () => {
			if (how.questsOwn) setAsideOptedOut(sessionEnv(ctx), processOverlay(ctx));
		};
		if (name === null) {
			if (optedOut) layOptedOut(sessionEnv(ctx), processOverlay(ctx));
			else liftBudget(sessionEnv(ctx), processOverlay(ctx));
			ownWord();
			// A capped key moves even work said to draw on none, for its hour.
			layCapped(ctx);
			recordDrawn(pi, ctx);
			return;
		}
		const drawing = await host.draw(name);
		if (ask !== asking) return;
		if (drawing.kind === "drawn") {
			layBudget(
				sessionEnv(ctx),
				{ name, label: drawing.label, env: drawing.env },
				processOverlay(ctx),
			);
			ownWord();
			recordDrawn(pi, ctx, { drawing, judged });
			// The person was told calls use the fallback, so they're told this
			// ends it, rather than left to think it goes on.
			if (told.delete(name)) {
				journal(
					`budget ${name} can be drawn on now, so model calls draw on it again`,
				);
				ctx.ui.notify(
					`Budget ${name} can be drawn on now, so model calls draw on it again.`,
					"info",
				);
			}
			return;
		}
		liftBudget(sessionEnv(ctx), processOverlay(ctx));
		ownWord();
		const started = sessionEnv(ctx).snapshot();
		const inherited = budgetDrawnOn(started);
		// Started on the very budget the quest names, with its keys, the
		// calls draw on it still: nothing is missed, so nothing is said or
		// asked again. Named without its keys listed, the host's key bills
		// them (host/engine/kept-requests.ts), so that is a miss.
		if (inherited === name && carriesItsKeys(started)) {
			told.delete(name);
			recordDrawn(pi, ctx);
			return;
		}
		missedAt = now();
		missedWait = retrying ? waitAfter(missedWait) : 0;
		const unresolved = { budget: name, missing: missingFrom(drawing) };
		const fallback = layCapped(ctx)
			? cappedFallback(capped?.name ?? "")
			: fallbackOf(inherited);
		// A retry that misses again says nothing new, even when the
		// provider's words differ, so a provider that stays down writes no
		// line a minute.
		if (
			retrying &&
			!changed &&
			lastRecordOn(branchOf(ctx))?.unresolved?.budget === name
		) {
			pi.events.emit(BUDGET_SETTLED, {
				name: budgetDrawnOn(sessionEnv(ctx).snapshot()),
			} satisfies BudgetSettled);
			return;
		}
		if (recordDrawn(pi, ctx, { unresolved, judged })) {
			const namer = state.questId
				? `quest ${state.questId}`
				: "this session's folder or first prompt";
			journal(
				`${namer} names budget ${name}, which can't be drawn on: ${unresolved.missing}; model calls use ${fallback}`,
			);
		}
		if (told.has(name)) return;
		told.add(name);
		ctx.ui.notify(undrawable(name, drawing, fallback), "warning");
	};

	// The person's own key refused for its cap: move to the budget named
	// for that, if the session draws on none (lib/budget/capped.ts).
	const takeCapped = async (because: string): Promise<string | null> => {
		const ctx = last;
		if (!ctx || !options.whenCapped) return null;
		if (budgetDrawnOn(sessionEnv(ctx).snapshot()) !== null) return null;
		const { name, unreadable } = await options.whenCapped();
		if (unreadable) {
			journal(
				`${questOf()} can't move off the person's capped key: the setting naming a budget for it can't be read: ${quoted(unreadable)}`,
			);
			return null;
		}
		if (!name || last !== ctx) return null;
		const drawing = await host.draw(name);
		if (last !== ctx) return null;
		const why = `the person's own key is over its cap: ${quoted(because)}`;
		if (drawing.kind !== "drawn") {
			journal(
				`${questOf()} can't move to budget ${name}, though ${why}: ${missingFrom(drawing)}`,
			);
			return null;
		}
		// A budget laid while the draw was on its way stands.
		if (budgetDrawnOn(sessionEnv(ctx).snapshot()) !== null) return null;
		capped = { name, label: drawing.label, env: drawing.env, at: wallNow() };
		layCapped(ctx);
		recordDrawn(pi, ctx, { drawing, because: why });
		journal(`${questOf()} moves to budget ${name}, since ${why}`);
		if (!saidCapped) {
			saidCapped = true;
			ctx.ui.notify(
				`Your own key is over its cap, so this session's model calls draw on budget ${name} for the next hour.`,
				"warning",
			);
		}
		return name;
	};
	const questOf = () =>
		state.questId ? `quest ${state.questId}` : "a session with no quest";
	onBudgetCapped(pi.events, (because) =>
		takeCapped(because).catch(() => {
			// A context gone stale mid-draw moves nothing; the turn ends as it did.
			return null;
		}),
	);

	// A provider that registers late may know the name nothing did, or,
	// for a session on no quest, the folder nothing named.
	host.onRegistered(() => {
		// Asked again even on a quest, for free, so a session that leaves
		// it takes the folder's budget the provider now names.
		folderAsked = undefined;
		if (!state.questId) {
			// Only a judgement that answered none is asked again. A sure one
			// stands, and so does one still on its way, rather than a paid one
			// asked over it that a failure or a stop would take it off.
			if (promptNamed === null) promptAsked = undefined;
		}
		if (!last || (typeof wanted !== "string" && state.questId)) return;
		keep(last, true).catch(() => {
			// Nothing awaits this ask, and an unwatched rejection ends pi;
			// the next keep, before the next model call, asks again.
		});
	});

	// A draw that missed its deadline has drawn since: settle again now,
	// when the answer stands in for the late one, rather than at a retry
	// a busy host may have doubled to many minutes, the calls between
	// billed to the fallback key.
	host.onDrawnLate((name) => {
		if (!last || wanted !== name) return;
		keep(last, true).catch(() => {
			// Nothing awaits this ask, and an unwatched rejection ends pi;
			// the next keep, before the next model call, asks again.
		});
	});

	const forget = () => {
		last = undefined;
		// Asked again in full by the next session's first keep, and any
		// answer still on its way is overtaken, so it lays nothing.
		wanted = undefined;
		wantedOptedOut = false;
		wantedQuestsOwn = false;
		beenOnQuest = false;
		judgedRead = false;
		missedAt = undefined;
		missedWait = 0;
		capped = undefined;
		saidCapped = false;
		asking++;
		sessions++;
		folderAsked = undefined;
		promptAsked = undefined;
		promptNamed = undefined;
		redrawOwed = false;
		firstPrompt = undefined;
		startedOn = undefined;
	};

	return {
		keep: (ctx, options) => keep(ctx, options?.again ?? false, options?.prompt),
		forget,
	};
}

/**
 * The budget the session's environment carried before this keeper laid
 * one, "" for none: read beneath the overlay, so a budget a reloaded or
 * earlier session's keeper laid is never taken for one it started on.
 */
function inheritedBudget(ctx: ExtensionContext): string {
	// Started by work said to be the person's own, which it keeps to.
	if (beneathOverlay(ctx, BUDGET_OPTED_OUT_VARIABLE)?.trim()) return NO_BUDGET;
	return beneathOverlay(ctx, BUDGET_VARIABLE)?.trim() ?? "";
}

/** What `key` held before this session's keeper laid anything over it. */
function beneathOverlay(
	ctx: ExtensionContext,
	key: string,
): string | undefined {
	const laid = processOverlay(ctx).laid.get(key);
	const now = sessionEnv(ctx).get(key);
	return laid && now === laid.value ? laid.before : now;
}

/** Whether the session's log says it was on a quest at some point. */
function wasOnQuest(ctx: ExtensionContext): boolean {
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (entry.type !== "custom" || entry.customType !== SESSION_KEY) continue;
		const data: unknown = entry.data;
		if (isRecord(data) && typeof data.questId === "string") return true;
	}
	return false;
}

/**
 * The first words asking the session's work in its conversation, so a
 * keeper reloaded mid-conversation judges them again rather than a
 * follow-up like "go on": a person's, or those its start left it, and
 * never anything else the harness said under its header, such as a
 * job's report.
 */
function firstPromptOf(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		const text = userTextOf(entry);
		const ask = text === undefined ? undefined : askOf(text);
		if (ask) return ask;
	}
	return undefined;
}

/**
 * What `text` asks of the session, trimmed: a person's words, or those
 * its start left it, without their header, since a sprout that made no
 * quest is judged on the ask it was started for. Nothing for anything
 * else the harness said, or for blank words.
 */
function askOf(text: string): string | undefined {
	// A spawn's words name its quest, whose budget rules; one left loose
	// by a quest that failed to load is judged on what a person asks.
	if (isSpawnedText(text)) return undefined;
	const started = startWordsOf(text);
	const ask = started ?? (isPersonText(text) ? text : undefined);
	return ask?.trim() || undefined;
}

/**
 * Write the budget this session now draws on into its log, unless the
 * last entry on its branch already says it. It is read back from the
 * environment, so a budget inherited from the process that started
 * this one is what's written when this session lays none of its own.
 * The bus hears it every time, written or not, since a footer that
 * loaded after the entry was written still needs telling. With
 * `unresolved`, the entry says the budget the quest named and what
 * was missing, and is written again when that changes though the name
 * drawn on doesn't. Says whether it wrote one.
 */
function recordDrawn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	saying: {
		readonly drawing?: { readonly provider: string; readonly label: string };
		readonly unresolved?: UnresolvedBudget;
		readonly because?: string;
		/** Whether a judgement named the budget drawn on or missed. */
		readonly judged?: boolean;
	} = {},
): boolean {
	const { drawing, unresolved, because } = saying;
	const name = budgetDrawnOn(sessionEnv(ctx).snapshot());
	const settled: BudgetSettled = { name };
	pi.events.emit(BUDGET_SETTLED, settled);
	const laid = drawing && name !== null;
	const judged = (saying.judged ?? false) && (laid || unresolved !== undefined);
	const last = lastRecordOn(branchOf(ctx));
	if (
		last?.name === name &&
		last.unresolved?.budget === unresolved?.budget &&
		last.unresolved?.missing === unresolved?.missing &&
		(because === undefined || last.because === because) &&
		(last.judged ?? false) === judged
	)
		return false;
	const record: BudgetRecord = laid
		? {
				v: 1,
				name,
				label: drawing.label,
				provider: drawing.provider,
				...(because ? { because } : {}),
				...(judged ? { judged: true as const } : {}),
			}
		: {
				v: 1,
				name,
				...(unresolved ? { unresolved } : {}),
				...(judged ? { judged: true as const } : {}),
			};
	pi.appendEntry(BUDGET_ENTRY, record);
	return true;
}

/** Whether the budget an environment names comes with every key it listed. */
function carriesItsKeys(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	const keys = budgetKeysOf(env);
	return keys.length > 0 && keys.every((key) => env[key] !== undefined);
}

/** The wait after a retry missed, given the wait it came after. */
function waitAfter(wait: number): number {
	if (wait < BUDGET_ASKED_AGAIN_MS) return BUDGET_ASKED_AGAIN_MS;
	return Math.min(wait * 2, BUDGET_ASKED_AGAIN_MOST_MS);
}

/**
 * The newest record on a branch whose budget a judgement named, or
 * undefined when none was.
 */
function lastJudgedOn(
	branch: Parameters<typeof lastRecordOn>[0],
): BudgetRecord | undefined {
	for (let at = branch.length - 1; at >= 0; at--) {
		const entry = branch[at];
		if (entry?.type !== "custom" || entry.customType !== BUDGET_ENTRY) continue;
		const record = recordIn(entry.data);
		if (record?.judged) return record;
	}
	return undefined;
}

/** The session's branch, or none where its manager can't say. */
function branchOf(ctx: ExtensionContext): Parameters<typeof lastRecordOn>[0] {
	return ctx.sessionManager?.getBranch?.() ?? [];
}

/**
 * What was missing for a budget not drawn on, in a few words, with
 * what each provider said `quoted`.
 */
function missingFrom(
	drawing: Exclude<BudgetDrawing, { kind: "drawn" }>,
): string {
	if (drawing.kind === "unavailable") {
		return `${JSON.stringify(drawing.provider)}: ${quoted(drawing.reason)}`;
	}
	return drawing.asked.length === 0
		? "no budget provider is installed"
		: `no budget provider knows it (asked ${drawing.asked.map((id) => JSON.stringify(id)).join(", ")})`;
}

/**
 * A provider's words, on one line and cut to `SAID_KEPT` characters
 * before they are quoted: a credential program's stderr is the
 * provider's reason, and the journal and the session's log keep it
 * long after the notice. Its line breaks become spaces first, so what
 * is kept is the words rather than their escapes.
 */
function quoted(said: unknown): string {
	const line = oneLine(said);
	const kept =
		line.length > SAID_KEPT ? `${line.slice(0, SAID_KEPT)} (cut short)` : line;
	return JSON.stringify(kept);
}

/**
 * What a provider said, as one line of text: a reason that isn't a
 * string, which a provider on the bus may send, is said to be missing
 * rather than failing the ask that reads it.
 */
function oneLine(said: unknown): string {
	if (typeof said !== "string") return "(no reason given)";
	// Control characters go too, so a program's escapes reach no terminal.
	return said.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

/** How much of a provider's words the journal and the log keep. */
const SAID_KEPT = 200;

/**
 * What model calls draw on once a budget isn't: the budget the process
 * was started on, `inherited`, or the session's default.
 */
function fallbackOf(inherited: string | null): string {
	return inherited === null
		? "the session's default"
		: `budget ${inherited}, which this session was started on`;
}

/** What model calls draw on once a capped key moved them to `name`. */
function cappedFallback(name: string): string {
	return `budget ${name}, since the person's own key is over its cap`;
}

/** The colours a budget line is drawn in. */
interface BudgetTheme {
	fg(colour: "warning", text: string): string;
}

/**
 * The line a `budget` entry draws in the session: one for a budget the
 * quest named but the session couldn't draw on, and nothing for any
 * other, which is the log's alone.
 */
export function budgetEntryView(
	data: unknown,
	theme: BudgetTheme,
): Text | undefined {
	const record = recordIn(data);
	const unresolved = record?.unresolved;
	if (!record || !unresolved) return undefined;
	return new Text(
		theme.fg(
			"warning",
			`Budget ${unresolved.budget} isn't drawn on (${unresolved.missing}); model calls use ${fallbackOf(record.name)}. On a quest, \`quest budget\` names another.`,
		),
		0,
		0,
	);
}

/**
 * Why a budget could not be drawn on, in words for the person. Provider
 * ids are quoted, so an id can't add a line of its own.
 */
export function undrawable(
	name: string,
	drawing: Exclude<BudgetDrawing, { kind: "drawn" }>,
	fallback = fallbackOf(null),
): string {
	if (drawing.kind === "unavailable") {
		return `Budget ${name} can't be drawn on yet (${JSON.stringify(drawing.provider)}): ${oneLine(drawing.reason)} Model calls use ${fallback} until then.`;
	}
	return drawing.asked.length === 0
		? `No budget provider is installed, so budget ${name} means nothing yet; model calls use ${fallback}.`
		: `No budget provider knows ${name} (asked ${drawing.asked.map((id) => JSON.stringify(id)).join(", ")}), so model calls use ${fallback}.`;
}
