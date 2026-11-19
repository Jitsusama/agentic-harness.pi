/**
 * The host side of the budget contract: the providers registered over
 * the bus, asking them in turn what a budget's name means, and asking
 * them all at once which budget a folder's work draws on.
 *
 * Kept apart from the extension that hosts it so the chain can be
 * tested without pi, and so the contract's two halves sit together.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetAnswer,
	type BudgetHostApi,
	type BudgetProvider,
	type Classify,
	isBudgetName,
	isBudgetProvider,
	type WorkJudgement,
	type WorkToBudget,
} from "./provider.ts";

/** What asking the providers about one name came to. */
export type BudgetDrawing =
	| {
			readonly kind: "drawn";
			readonly provider: string;
			readonly env: Readonly<Record<string, string>>;
			readonly label: string;
	  }
	| {
			readonly kind: "unavailable";
			readonly provider: string;
			readonly reason: string;
	  }
	| {
			/** No provider knew the name; these were asked. */
			readonly kind: "unknown";
			readonly asked: readonly string[];
	  };

/** The host: its registry, and the one question it asks of it. */
export interface BudgetHost extends BudgetHostApi {
	/** Ask each provider, lowest precedence first, what `name` means. */
	draw(name: string): Promise<BudgetDrawing>;
	/** Be told each time a provider registers, as a late one may answer. */
	onRegistered(listener: () => void): void;
	/**
	 * The budget work in `folder` draws on, from the first provider,
	 * lowest precedence first, that names one, and which it was. Every
	 * provider is asked at once and given the one deadline, so a create
	 * waits at most that long however many there are. A provider that
	 * fails, answers late, or names `none` or something that can't be a
	 * budget is passed over: a folder only ever names a budget to draw
	 * on, and opting out stays the person's word on a quest.
	 */
	budgetFor(folder: string): Promise<FolderBudget | undefined>;
	/**
	 * Which budget `work` draws on, as the first provider, lowest
	 * precedence first, that judges it surely says, else the first that
	 * judges it at all, and which it was. Asked at once under the one
	 * deadline, as `budgetFor` is, though a longer one, since a
	 * judgement waits on a model. One that fails, answers late or names
	 * something that can't be a budget is passed over. The classifier
	 * each is handed aborts at the deadline, or with `signal`.
	 */
	budgetForWork(
		work: WorkToBudget,
		classify: Classify,
		signal?: AbortSignal,
	): Promise<WorkBudget | undefined>;
}

/** A provider's judgement of which budget some work draws on. */
export interface WorkBudget extends WorkJudgement {
	readonly provider: string;
}

/** The budget a provider says a folder's work draws on. */
export interface FolderBudget {
	readonly name: string;
	readonly provider: string;
}

/**
 * Host budget providers on `bus`: take their registrations, answer a
 * request for the host, and announce it once now.
 */
export function hostBudgets(
	bus: Pick<EventBus, "emit" | "on">,
	deadlineMs: number = BUDGET_ANSWER_DEADLINE_MS,
	judgeMs: number = BUDGET_JUDGEMENT_DEADLINE_MS,
): BudgetHost {
	const providers = new Map<string, BudgetProvider>();
	const listeners: (() => void)[] = [];
	const ordered = () =>
		[...providers.values()].sort((a, b) => a.precedence - b.precedence);
	const host: BudgetHost = {
		registerProvider(provider) {
			providers.set(provider.id, provider);
			for (const listener of listeners) listener();
		},
		listProviders: () => ordered().map((provider) => provider.id),
		onRegistered(listener) {
			listeners.push(listener);
		},
		async draw(name) {
			const asked: string[] = [];
			for (const provider of ordered()) {
				asked.push(provider.id);
				const answer = await askOne(provider, name, deadlineMs);
				if (answer.kind === "unknown") continue;
				return { ...answer, provider: provider.id };
			}
			return { kind: "unknown", asked };
		},
		async budgetFor(folder) {
			const asking = ordered().filter((p) => typeof p.budgetFor === "function");
			// All asked at once, and read in order, so the answer comes as
			// soon as every provider before the first to name one has said.
			const names = asking.map((provider) =>
				askFolder(provider, folder, deadlineMs),
			);
			for (const [at, provider] of asking.entries()) {
				const name = await names[at];
				if (name !== undefined) return { name, provider: provider.id };
			}
			return undefined;
		},
		async budgetForWork(work, classify, signal) {
			const asking = ordered().filter(
				(p) => typeof p.budgetForWork === "function",
			);
			// Aborted once the answer is settled, so the providers after a
			// sure one stop their classifier calls rather than paying on.
			const settled = new AbortController();
			const asked = signal
				? AbortSignal.any([signal, settled.signal])
				: settled.signal;
			const judged = asking.map((provider) =>
				askWork(provider, work, classify, judgeMs, asked),
			);
			try {
				// A sure answer from any wins over an unsure one from a
				// provider before it, which named nothing and only guessed.
				let guess: WorkBudget | undefined;
				let cut = false;
				for (const [at, provider] of asking.entries()) {
					const judgement = await judged[at];
					if (judgement === CUT_OFF) cut = true;
					if (!judgement || judgement === CUT_OFF) continue;
					const said = { ...judgement, provider: provider.id };
					if (said.sure) return said;
					guess ??= said;
				}
				// A guess is the answer only when no provider that might have
				// been sure was stopped first: a judgement cut short is none,
				// and is asked again, rather than an unsure one journaled.
				return cut ? undefined : guess;
			} finally {
				settled.abort();
			}
		},
	};
	bus.on(BUDGET_REGISTER_PROVIDER, (data: unknown) => {
		if (isBudgetProvider(data)) host.registerProvider(data);
	});
	const api: BudgetHostApi = {
		registerProvider: host.registerProvider,
		listProviders: host.listProviders,
	};
	bus.on(BUDGET_REQUEST, () => bus.emit(BUDGET_READY, api));
	bus.emit(BUDGET_READY, api);
	return host;
}

/**
 * How long a provider may take to answer. Session start and quest
 * actions wait on the answer, so one stuck on a password manager's
 * prompt must not hold them.
 */
export const BUDGET_ANSWER_DEADLINE_MS = 5_000;

/**
 * How long a provider may take to judge work. A classifier answers in
 * a few seconds and a create waits on it only once, when nothing else
 * names its budget; past this, the quest is made unjudged.
 */
export const BUDGET_JUDGEMENT_DEADLINE_MS = 20_000;

/** The most of a provider's why a line about it carries. */
const LONGEST_WHY = 300;

/** What a provider stopped by the deadline or the caller said. */
const CUT_OFF = "cut off";

/**
 * One provider's judgement of `work`, undefined when it can't say,
 * fails or names no budget's name, or `CUT_OFF` when the deadline or
 * the caller stopped it first. Its why is made one line, since every
 * line about it quotes it.
 */
async function askWork(
	provider: BudgetProvider,
	work: WorkToBudget,
	classify: Classify,
	deadlineMs: number,
	signal: AbortSignal | undefined,
): Promise<WorkJudgement | typeof CUT_OFF | undefined> {
	if (signal?.aborted) return CUT_OFF;
	// Aborted at the deadline, so a classifier call nobody waits on any
	// more stops rather than running, and costing, on.
	const cutoff = new AbortController();
	const stop = signal
		? AbortSignal.any([signal, cutoff.signal])
		: cutoff.signal;
	const bounded: Classify = (context, own) =>
		classify(context, own ? AbortSignal.any([own, stop]) : stop);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let end: (() => void) | undefined;
	const late = new Promise<undefined>((resolve) => {
		end = () => {
			cutoff.abort();
			resolve(undefined);
		};
		timer = setTimeout(end, deadlineMs);
		signal?.addEventListener("abort", end, { once: true });
	});
	try {
		const judged = await Promise.race([
			provider.budgetForWork?.(work, bounded),
			late,
		]);
		if (stop.aborted) return CUT_OFF;
		if (
			typeof judged !== "object" ||
			judged === null ||
			typeof judged.name !== "string" ||
			!isBudgetName(judged.name)
		) {
			return undefined;
		}
		const why =
			typeof judged.why === "string"
				? judged.why.replace(/\s+/g, " ").trim().slice(0, LONGEST_WHY)
				: "";
		return { name: judged.name, why, sure: judged.sure === true };
	} catch {
		// A provider that can't judge is passed over, as one that won't;
		// one that failed because it was stopped was cut off, not wrong.
		return stop.aborted ? CUT_OFF : undefined;
	} finally {
		clearTimeout(timer);
		// One sweep asks many times under one signal, so each ask takes
		// its listener away again.
		if (end) signal?.removeEventListener("abort", end);
	}
}

/**
 * The word a quest opts out of budgets with, which a folder's answer
 * never stands for (lib/internal/quest/fields/budget.ts's NO_BUDGET,
 * which lib/budget doesn't import, since it sits below quests).
 */
const FOLDER_OPTS_OUT = "none";

/**
 * The budget one provider says `folder` draws on, or undefined when it
 * names none, fails, names `none` or no budget's name, or doesn't
 * answer within the deadline: a create waits on this, so it can't
 * wait for long.
 */
async function askFolder(
	provider: BudgetProvider,
	folder: string,
	deadlineMs: number,
): Promise<string | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), deadlineMs);
	});
	try {
		const name = await Promise.race([provider.budgetFor?.(folder), late]);
		return typeof name === "string" &&
			isBudgetName(name) &&
			name !== FOLDER_OPTS_OUT
			? name
			: undefined;
	} catch {
		// A provider that can't say is passed over, as one that names none.
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One provider's answer, with a rejection, or no answer within the
 * deadline, read as unavailable.
 */
async function askOne(
	provider: BudgetProvider,
	name: string,
	deadlineMs: number,
): Promise<BudgetAnswer> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<BudgetAnswer>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "unavailable",
					// The answer names the provider beside its reason, quoted, so
					// the reason leaves it out rather than say it twice, or raw.
					reason: `It didn't answer within ${deadlineMs / 1000} s.`,
				}),
			deadlineMs,
		);
	});
	try {
		return await Promise.race([provider.resolve(name), late]);
	} catch (error) {
		return {
			kind: "unavailable" as const,
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}
