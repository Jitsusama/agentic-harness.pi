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
	 * on, and opting out stays the person's word on a quest. One that
	 * fails or answers late is told to the host's `troubled`, since a
	 * quest it leaves unnamed draws on the person's own key.
	 */
	budgetFor(folder: string): Promise<FolderBudget | undefined>;
}

/** The budget a provider says a folder's work draws on. */
export interface FolderBudget {
	readonly name: string;
	readonly provider: string;
}

/**
 * What a provider asked about a folder couldn't say: which, the
 * folder, and why.
 */
export interface FolderTrouble {
	readonly provider: string;
	readonly folder: string;
	readonly why: string;
}

/**
 * Host budget providers on `bus`: take their registrations, answer a
 * request for the host, and announce it once now. A provider that
 * fails or answers late when asked about a folder is told to
 * `troubled`.
 */
export function hostBudgets(
	bus: Pick<EventBus, "emit" | "on">,
	deadlineMs: number = BUDGET_ANSWER_DEADLINE_MS,
	troubled: (trouble: FolderTrouble) => void = () => undefined,
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
			// One that fails or answers late is told to troubled even when
			// an earlier one has already answered.
			const names = asking.map(async (provider) => {
				const said = await askFolder(provider, folder, deadlineMs);
				if (typeof said === "string") return said;
				if (said)
					tell(troubled, { provider: provider.id, folder, why: said.why });
				return undefined;
			});
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
 * Tells `troubled` of a folder ask's trouble. A sink that throws is
 * passed over: a read nobody awaits once an earlier provider answered
 * must not leave a rejection behind.
 */
function tell(
	troubled: (trouble: FolderTrouble) => void,
	trouble: FolderTrouble,
): void {
	try {
		troubled(trouble);
	} catch {
		// The trouble goes unsaid; the budget the folder draws on stands.
	}
}

/** What a folder's ask races its answer against. */
const LATE: unique symbol = Symbol("late");

/**
 * The budget one provider says `folder` draws on; undefined when it
 * names none, `none` or no budget's name; or why it couldn't say, when
 * it fails or doesn't answer within the deadline: a create waits on
 * this, so it can't wait for long.
 */
async function askFolder(
	provider: BudgetProvider,
	folder: string,
	deadlineMs: number,
): Promise<string | { readonly why: string } | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<typeof LATE>((resolve) => {
		timer = setTimeout(() => resolve(LATE), deadlineMs);
	});
	try {
		const name = await Promise.race([provider.budgetFor?.(folder), late]);
		if (name === LATE) {
			return { why: `it didn't answer within ${deadlineMs / 1000} s` };
		}
		return typeof name === "string" &&
			isBudgetName(name) &&
			name !== FOLDER_OPTS_OUT
			? name
			: undefined;
	} catch (error) {
		// Passed over, as one that names none, and said why.
		return { why: `it failed: ${whatFailed(error)}` };
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
		return { kind: "unavailable" as const, reason: whatFailed(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What a provider's failure says, whatever it threw: a catch that
 * threw in turn would leave the rejection an unawaited ask must not.
 */
function whatFailed(error: unknown): string {
	try {
		return error instanceof Error ? String(error.message) : String(error);
	} catch {
		// A thrown thing whose words throw in turn still failed; say only that.
		return "something that can't be said";
	}
}
