import { globToRegex } from "../surface/policy.js";
import type { McpTool } from "../types.js";
import type {
	FrontEndMatcher,
	FrontEndProvider,
	ResolvedFrontEnd,
} from "./types.js";

/** A registry of front-end providers that resolves the winning hooks for a tool. */
export interface FrontEndRegistry {
	register(provider: FrontEndProvider): void;
	unregister(serverId: string, providerId: string): void;
	resolve(tool: McpTool): ResolvedFrontEnd;
	list(): FrontEndProvider[];
}

/** The hooks resolution ranks over; each is resolved independently. */
const HOOKS = ["shape", "renderCall", "renderResult", "wrap"] as const;

/**
 * Create a registry keyed by (serverId, providerId). Registering under an
 * existing key replaces in place, so the load-order double-cover is idempotent.
 * `resolve` picks, for each hook, the highest-specificity matching provider
 * that supplies it, falling back to the injected default.
 */
export function createFrontEndRegistry(deps: {
	backendOf: (name: string) => string;
	defaults: ResolvedFrontEnd;
}): FrontEndRegistry {
	const providers = new Map<string, FrontEndProvider>();
	const key = (serverId: string, providerId: string) =>
		`${serverId}\u0000${providerId}`;

	return {
		register(provider) {
			providers.set(key(provider.serverId, provider.providerId), provider);
		},
		unregister(serverId, providerId) {
			providers.delete(key(serverId, providerId));
		},
		list() {
			return [...providers.values()];
		},
		resolve(tool) {
			const matching = [...providers.values()].filter(
				(p) =>
					p.serverId === tool.serverId &&
					matches(p.match, tool, deps.backendOf),
			);
			const resolved: Record<string, unknown> = { ...deps.defaults };
			for (const hook of HOOKS) {
				const winner = bestFor(matching, hook);
				// bestFor only returns a provider that supplies this hook.
				if (winner) resolved[hook] = winner[hook];
			}
			return resolved as unknown as ResolvedFrontEnd;
		},
	};
}

/** Pick the highest-ranked provider that supplies `hook`, or undefined if none do. */
function bestFor(
	providers: FrontEndProvider[],
	hook: (typeof HOOKS)[number],
): FrontEndProvider | undefined {
	return providers
		.filter((p) => typeof p[hook] === "function")
		.sort((a, b) => compare(b, a))[0];
}

/** Total order over providers: specificity tier, glob literal length, priority, then providerId. */
function compare(a: FrontEndProvider, b: FrontEndProvider): number {
	const ra = rank(a.match);
	const rb = rank(b.match);
	if (ra.tier !== rb.tier) return ra.tier - rb.tier;
	if (ra.literal !== rb.literal) return ra.literal - rb.literal;
	const pa = a.priority ?? 0;
	const pb = b.priority ?? 0;
	if (pa !== pb) return pa - pb;
	return a.providerId < b.providerId ? 1 : a.providerId > b.providerId ? -1 : 0;
}

/** Specificity of a matcher: a tier (higher is more specific) and, for globs, the literal-character count. */
function rank(match: FrontEndMatcher): { tier: number; literal: number } {
	switch (match.kind) {
		case "tool":
			return { tier: 3, literal: 0 };
		case "glob":
			return { tier: 2, literal: match.pattern.replace(/\*/g, "").length };
		case "backend":
			return { tier: 1, literal: 0 };
		case "predicate":
			return { tier: 0, literal: 0 };
	}
}

/** Whether a matcher applies to a tool. */
function matches(
	match: FrontEndMatcher,
	tool: McpTool,
	backendOf: (name: string) => string,
): boolean {
	switch (match.kind) {
		case "tool":
			return match.name === tool.name;
		case "glob":
			return globToRegex(match.pattern).test(tool.name);
		case "backend":
			return match.backend === backendOf(tool.name);
		case "predicate":
			return match.test(tool);
	}
}
