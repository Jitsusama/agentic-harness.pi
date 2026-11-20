/**
 * The loaded quest's budget, laid over this session's environment.
 *
 * Quest-workflow hosts the budget providers (lib/budget/host.ts), since
 * it is what knows which quest a session is on. When the session
 * starts and after every quest action, it works out the budget the
 * loaded quest draws on (its own, or its nearest ancestor's), asks
 * the providers what that name means and lays the answer over
 * the session's environment, putting back what was there when the quest draws on
 * none or the session puts it down. Model providers read their keys
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
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { onBudgetCapped } from "../../lib/budget/capped.ts";
import {
	layBudget,
	liftBudget,
	processOverlay,
} from "../../lib/budget/environment.ts";
import {
	type BudgetDrawing,
	type FolderBudget,
	hostBudgets,
} from "../../lib/budget/host.ts";
import {
	BUDGET_ENTRY,
	BUDGET_SETTLED,
	type BudgetRecord,
	type BudgetSettled,
	budgetDrawnOn,
	budgetKeysOf,
	lastRecordOn,
	recordIn,
	type UnresolvedBudget,
} from "../../lib/budget/record.ts";
import { sessionEnv } from "../../lib/core/session/index.ts";
import { budgetInRecord } from "../../lib/internal/quest/fields/budget.ts";
import {
	journalCommand,
	sayInJournal,
} from "../../lib/internal/session/journal.ts";
import type { QuestState } from "./state.ts";

/** What keeps the session on its quest's budget. */
export interface BudgetKeeper {
	/**
	 * Draw on the budget the loaded quest names, if it changed. With
	 * `again`, ask the providers even when it didn't: naming a budget
	 * once more is how a person takes up one whose file they just wrote.
	 */
	keep(ctx: ExtensionContext, options?: { again?: boolean }): Promise<void>;
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
}

/**
 * How long a session the cap moved stays on the budget named for it
 * before its own key is drawn on again: the cap lifts when its week
 * turns or the person claims more, and a call refused once more costs
 * nothing but the move back.
 */
export const CAPPED_HOLD_MS = 60 * 60_000;

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
	const host = hostBudgets(pi.events, undefined, (trouble) =>
		journal(
			`budget provider ${JSON.stringify(trouble.provider)} couldn't say which budget ${JSON.stringify(trouble.folder)} draws on, so its answer is passed over: ${quoted(trouble.why)}`,
		),
	);
	folderBudgets.set(state, (folder) => host.budgetFor(folder));
	/** The name last drawn on or asked for, null for none. */
	let wanted: string | null | undefined;
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

	const keep = async (ctx: ExtensionContext, again = false) => {
		last = ctx;
		const name = state.questId
			? (budgetInRecord(state.questsRoot, state.questId)?.name ?? null)
			: null;
		const due = missedAt !== undefined && now() - missedAt >= missedWait;
		// Its hour out, a capped key is drawn on again, so settle afresh.
		const cappedOut =
			capped !== undefined && wallNow() - capped.at >= CAPPED_HOLD_MS;
		if (cappedOut) capped = undefined;
		if (name === wanted && !again && !due && !cappedOut) return pending;
		// Due or not, a name missed before is a retry, so a capped key's hour
		// running out doesn't start its backoff afresh.
		const retrying = name === wanted && !again && missedAt !== undefined;
		wanted = name;
		missedAt = undefined;
		const ask = ++asking;
		pending = settle(ctx, name, ask, retrying);
		return pending;
	};

	const settle = async (
		ctx: ExtensionContext,
		name: string | null,
		ask: number,
		retrying = false,
	) => {
		if (name === null) {
			liftBudget(sessionEnv(ctx), processOverlay(ctx));
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
			told.delete(name);
			recordDrawn(pi, ctx, drawing);
			return;
		}
		liftBudget(sessionEnv(ctx), processOverlay(ctx));
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
		if (retrying && lastRecordOn(branchOf(ctx))?.unresolved?.budget === name) {
			pi.events.emit(BUDGET_SETTLED, {
				name: budgetDrawnOn(sessionEnv(ctx).snapshot()),
			} satisfies BudgetSettled);
			return;
		}
		if (recordDrawn(pi, ctx, undefined, unresolved)) {
			const quest = state.questId ? `quest ${state.questId}` : "the quest";
			journal(
				`${quest} names budget ${name}, which can't be drawn on: ${unresolved.missing}; model calls use ${fallback}`,
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
		recordDrawn(pi, ctx, drawing, undefined, why);
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

	// A provider that registers late may know the name nothing did.
	host.onRegistered(() => {
		if (!last || typeof wanted !== "string") return;
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
		missedAt = undefined;
		missedWait = 0;
		capped = undefined;
		saidCapped = false;
		asking++;
	};

	return {
		keep: (ctx, options) => keep(ctx, options?.again ?? false),
		forget,
	};
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
	drawing?: { readonly provider: string; readonly label: string },
	unresolved?: UnresolvedBudget,
	because?: string,
): boolean {
	const name = budgetDrawnOn(sessionEnv(ctx).snapshot());
	const settled: BudgetSettled = { name };
	pi.events.emit(BUDGET_SETTLED, settled);
	const last = lastRecordOn(branchOf(ctx));
	if (
		last?.name === name &&
		last.unresolved?.budget === unresolved?.budget &&
		last.unresolved?.missing === unresolved?.missing &&
		(because === undefined || last.because === because)
	)
		return false;
	const record: BudgetRecord =
		drawing && name !== null
			? {
					v: 1,
					name,
					label: drawing.label,
					provider: drawing.provider,
					...(because ? { because } : {}),
				}
			: { v: 1, name, ...(unresolved ? { unresolved } : {}) };
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
			`Budget ${unresolved.budget} isn't drawn on (${unresolved.missing}); model calls use ${fallbackOf(record.name)}. \`quest budget\` names another.`,
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
