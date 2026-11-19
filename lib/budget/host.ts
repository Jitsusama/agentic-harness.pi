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
	isBudgetName,
	isBudgetProvider,
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
					// Quoted, as every line naming a provider does, so its id
					// can't add a line of its own to the notice it reaches.
					reason: `${JSON.stringify(provider.id)} didn't answer within ${deadlineMs / 1000} s.`,
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
