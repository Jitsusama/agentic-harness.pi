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
 * leaves the session on its default and says why, once a name. The
 * session's log says the budget drawn on (lib/budget/record.ts) each
 * time it changes, so whatever prices the log knows whose money each
 * request spent, and the bus says it each time it settles, for
 * spend-workflow's footer item, which tells it with its standing. Nothing of it goes
 * into the prompt: what a session bills is the person's to see, not
 * the model's to reason about.
 */

import { resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	layBudget,
	liftBudget,
	processOverlay,
} from "../../lib/budget/environment.ts";
import {
	type BudgetDrawing,
	type FolderBudget,
	hostBudgets,
	type WorkBudget,
} from "../../lib/budget/host.ts";
import type { Classify, WorkToBudget } from "../../lib/budget/provider.ts";
import {
	BUDGET_ENTRY,
	BUDGET_SETTLED,
	type BudgetRecord,
	type BudgetSettled,
	budgetDrawnOn,
	lastRecorded,
} from "../../lib/budget/record.ts";
import { findClassifier } from "../../lib/classifier/jev.ts";
import { sessionEnv } from "../../lib/core/session/index.ts";
import {
	budgetInRecord,
	NO_BUDGET,
} from "../../lib/internal/quest/fields/budget.ts";
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
 * passed over rather than every provider going unasked.
 */
export async function classifierOf(
	ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<Classify> {
	const failing =
		(reason: string): Classify =>
		() =>
			Promise.reject(new Error(reason));
	try {
		const found = await findClassifier(
			ctx,
			process.env[BUDGET_CLASSIFIER_ENV],
			BUDGET_CLASSIFIER_ENV,
		);
		return found.ok ? found.classify : failing(found.reason);
	} catch (error) {
		// A registry that throws is no classifier, said as one: a create
		// or keep that awaited it would otherwise fail over a judgement.
		return failing(error instanceof Error ? error.message : String(error));
	}
}

/** Host budget providers and keep the session on its quest's budget. */
export function keepQuestBudget(
	pi: ExtensionAPI,
	state: QuestState,
): BudgetKeeper {
	const host = hostBudgets(pi.events);
	folderBudgets.set(state, (folder) => host.budgetFor(folder));
	workBudgets.set(state, async (work, ctx, signal) =>
		host.budgetForWork(work, await classifierOf(ctx), signal),
	);
	/** The name last drawn on or asked for, null for none. */
	let wanted: string | null | undefined;
	/** Bumped on every ask, so an answer overtaken by another is dropped. */
	let asking = 0;
	/** Names already said to be undrawable, so each is said once. */
	const told = new Set<string>();
	let last: ExtensionContext | undefined;
	/** The ask still on its way, so a second keep can wait on it. */
	let pending: Promise<void> = Promise.resolve();

	/** What a session on no quest asked of its folder, once a session. */
	let folderAsked: Promise<string | null> | undefined;
	/** What it asked of its first prompt, once a session. */
	let promptAsked: Promise<string | null> | undefined;
	/** Bumped as a session is forgotten, so its asks lay nothing after. */
	let sessions = 0;

	/**
	 * The budget a session on no quest draws on: its folder's, else a
	 * sure judgement's of its folder and first prompt, or null for none.
	 */
	const looseName = async (
		ctx: ExtensionContext,
		prompt: string | undefined,
	): Promise<string | null> => {
		if (typeof ctx.cwd !== "string" || ctx.cwd === "") return null;
		const folder = resolve(ctx.cwd);
		// The session this ask is for: once forgotten, its answer is no
		// longer the next session's to keep or to say.
		const session = sessions;
		folderAsked ??= host.budgetFor(folder).then((taken) => {
			if (!taken || session !== sessions) return null;
			ctx.ui.notify(
				`This session is on no quest, so it draws on budget ${taken.name}, which ${JSON.stringify(taken.provider)} says work in ${JSON.stringify(folder)} draws on.`,
				"info",
			);
			return taken.name;
		});
		const byFolder = await folderAsked;
		if (session !== sessions) return null;
		if (byFolder !== null) return byFolder;
		const asked = prompt?.trim();
		if (!(promptAsked || asked)) return null;
		promptAsked ??= judgeLoose(ctx, folder, asked ?? "", session);
		const byPrompt = await promptAsked;
		return session === sessions ? byPrompt : null;
	};

	const judgeLoose = async (
		ctx: ExtensionContext,
		folder: string,
		prompt: string,
		session: number,
	): Promise<string | null> => {
		const judged = await host.budgetForWork(
			{ title: folder, folder, prompt: prompt.slice(0, LONGEST_PROMPT) },
			await classifierOf(ctx),
		);
		if (!judged?.sure || judged.name === NO_BUDGET || session !== sessions) {
			return null;
		}
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
		const name = state.questId
			? (budgetInRecord(state.questsRoot, state.questId)?.name ?? null)
			: await looseName(ctx, prompt);
		if (ctx !== last) return pending;
		if (name === wanted && !again) return pending;
		wanted = name;
		const ask = ++asking;
		pending = settle(ctx, name, ask);
		return pending;
	};

	const settle = async (
		ctx: ExtensionContext,
		name: string | null,
		ask: number,
	) => {
		if (name === null) {
			liftBudget(sessionEnv(ctx), processOverlay(ctx));
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
		recordDrawn(pi, ctx);
		if (told.has(name)) return;
		told.add(name);
		ctx.ui.notify(undrawable(name, drawing), "warning");
	};

	// A provider that registers late may know the name nothing did, or,
	// for a session on no quest, the folder nothing named.
	host.onRegistered(() => {
		if (!state.questId) {
			folderAsked = undefined;
			promptAsked = undefined;
		}
		if (!last || (typeof wanted !== "string" && state.questId)) return;
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
		asking++;
		sessions++;
		folderAsked = undefined;
		promptAsked = undefined;
	};

	return {
		keep: (ctx, options) => keep(ctx, options?.again ?? false, options?.prompt),
		forget,
	};
}

/**
 * Write the budget this session now draws on into its log, unless the
 * last entry on its branch already says it. It is read back from the
 * environment, so a budget inherited from the process that started
 * this one is what's written when this session lays none of its own.
 * The bus hears it every time, written or not, since a footer that
 * loaded after the entry was written still needs telling.
 */
function recordDrawn(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	drawing?: { readonly provider: string; readonly label: string },
): void {
	const name = budgetDrawnOn(sessionEnv(ctx).snapshot());
	const settled: BudgetSettled = { name };
	pi.events.emit(BUDGET_SETTLED, settled);
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	if (lastRecorded(branch) === name) return;
	const record: BudgetRecord =
		drawing && name !== null
			? { v: 1, name, label: drawing.label, provider: drawing.provider }
			: { v: 1, name };
	pi.appendEntry(BUDGET_ENTRY, record);
}

/**
 * Why a budget could not be drawn on, in words for the person. Provider
 * ids are quoted, so an id can't add a line of its own.
 */
export function undrawable(
	name: string,
	drawing: Exclude<BudgetDrawing, { kind: "drawn" }>,
): string {
	if (drawing.kind === "unavailable") {
		return `Budget ${name} can't be drawn on yet (${JSON.stringify(drawing.provider)}): ${drawing.reason} Model calls use the session's default until then.`;
	}
	return drawing.asked.length === 0
		? `No budget provider is installed, so budget ${name} means nothing yet; model calls use the session's default.`
		: `No budget provider knows ${name} (asked ${drawing.asked.map((id) => JSON.stringify(id)).join(", ")}), so model calls use the session's default.`;
}
