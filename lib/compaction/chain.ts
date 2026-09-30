/**
 * Which compaction providers are asked, and in what order.
 *
 * Unconfigured, every registered provider is asked, lowest precedence
 * first. `PI_COMPACTION_PROVIDERS` names the chain instead, as
 * comma-separated ids, and then exactly those are asked in that order;
 * an id nothing registered is reported rather than dropped quietly, so
 * a typo shows up on the compaction entry. `PI_COMPACTION_SUMMARY=pi`
 * is the older switch and means pi's summariser alone.
 */

import type { CompactionProvider } from "./provider.ts";

/** The id of the provider that writes with pi's own summariser. */
export const PI_PROVIDER_ID = "pi";

/** The providers to ask, and any configured id nothing registered. */
export interface CompactionChain {
	readonly providers: readonly CompactionProvider[];
	readonly unknown: readonly string[];
}

/** The configured chain, if the environment names one. */
export function configuredChain(
	env: Readonly<Record<string, string | undefined>>,
): readonly string[] | undefined {
	const named = (env.PI_COMPACTION_PROVIDERS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	if (named.length > 0) return [...new Set(named)];
	if (env.PI_COMPACTION_SUMMARY === "pi") return [PI_PROVIDER_ID];
	return undefined;
}

/** The chain to walk over what is registered, as configured. */
export function resolveChain(
	registered: Iterable<CompactionProvider>,
	env: Readonly<Record<string, string | undefined>>,
): CompactionChain {
	const byId = new Map<string, CompactionProvider>();
	for (const provider of registered) byId.set(provider.id, provider);
	const configured = configuredChain(env);
	if (!configured) {
		const providers = [...byId.values()].sort(
			(a, b) => a.precedence - b.precedence,
		);
		return { providers, unknown: [] };
	}
	const providers: CompactionProvider[] = [];
	const unknown: string[] = [];
	for (const id of configured) {
		const provider = byId.get(id);
		if (provider) providers.push(provider);
		else unknown.push(id);
	}
	return { providers, unknown };
}
