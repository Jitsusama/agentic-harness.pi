/**
 * The host side of the budget contract: the providers registered over
 * the bus, and asking them in turn what a budget's name means.
 *
 * Kept apart from the extension that hosts it so the chain can be
 * tested without pi, and so the contract's two halves sit together.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_READY,
	BUDGET_REGISTER_PROVIDER,
	BUDGET_REQUEST,
	type BudgetHostApi,
	type BudgetProvider,
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
}

/**
 * Host budget providers on `bus`: take their registrations, answer a
 * request for the host, and announce it once now.
 */
export function hostBudgets(bus: Pick<EventBus, "emit" | "on">): BudgetHost {
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
				const answer = await askOne(provider, name);
				if (answer.kind === "unknown") continue;
				return { ...answer, provider: provider.id };
			}
			return { kind: "unknown", asked };
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

/** One provider's answer, with a rejection read as unavailable. */
async function askOne(provider: BudgetProvider, name: string) {
	try {
		return await provider.resolve(name);
	} catch (error) {
		return {
			kind: "unavailable" as const,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
