import type { RoleModel } from "./model.js";

export interface RoleAssignment {
	readonly provider: string;
	readonly premium?: string;
	readonly primary?: string;
	readonly light?: string;
}

/**
 * Rank one provider's models by cache read cost, ascending, breaking a
 * tie by input cost and then by id, so the ranking never depends on
 * the order models happened to arrive in.
 */
function ranked(models: readonly RoleModel[]): RoleModel[] {
	return [...models].sort((a, b) => {
		if (a.cost.cacheRead !== b.cost.cacheRead) {
			return a.cost.cacheRead - b.cost.cacheRead;
		}
		if (a.cost.input !== b.cost.input) return a.cost.input - b.cost.input;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

/**
 * Resolve premium, primary and light per provider, ranked on cache
 * read cost first. One model is primary alone, since there is nothing
 * to rank it against. Two split into light and premium with no middle
 * to call primary. Three or more take the cheapest as light, the
 * dearest as premium, and the one at the middle rank as primary.
 */
export function deriveRoles(models: readonly RoleModel[]): RoleAssignment[] {
	const byProvider = new Map<string, RoleModel[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}

	const assignments: RoleAssignment[] = [];
	for (const [provider, providerModels] of byProvider) {
		const sorted = ranked(providerModels);
		if (sorted.length === 1) {
			assignments.push({ provider, primary: sorted[0].id });
			continue;
		}
		if (sorted.length === 2) {
			assignments.push({
				provider,
				light: sorted[0].id,
				premium: sorted[1].id,
			});
			continue;
		}
		const middle = sorted[Math.floor((sorted.length - 1) / 2)];
		assignments.push({
			provider,
			light: sorted[0].id,
			primary: middle.id,
			premium: sorted[sorted.length - 1].id,
		});
	}

	return assignments;
}
