/**
 * Who served a model request, as its response's headers say.
 *
 * Several times a day every session in flight lost its whole prompt cache
 * in the same minute, with nothing in pi changed: on 8 and 9 November, five
 * such bursts cost $40 to $60 each (80ECO2 [9a64b11e]). A cache is kept per
 * Anthropic account, so a proxy failing over to another account drops it
 * for everyone at once, and a provider evicting it looks the same from
 * here. The response says which: Shopify's proxy names the backend it
 * chose, Anthropic names the organization and workspace that answered, and
 * Cloudflare's ray ends in the edge the proxy was reached through.
 *
 * So a session records who served it, as a custom entry in its log that
 * the model never reads, whenever that changes, and the spend ledger
 * carries it onto every turn after (lib/ledger/branch.ts).
 */

/** The custom entry a session records who served it in. */
export const SERVED_ENTRY = "provider-served";

/** Who served a request: each part only when the response said it. */
export interface Served {
	/** The backend Shopify's proxy chose, as `anthropic-dev`. */
	readonly backend?: string;
	/** The Anthropic organization and workspace, as `<org>/<workspace>`. */
	readonly account?: string;
	/** Cloudflare's edge the proxy was reached through, as `ORD`. */
	readonly edge?: string;
}

/** Who served a response, from its headers, named in lower case. */
export function servedBy(
	headers: Readonly<Record<string, string | undefined>>,
): Served {
	const backend = headers["x-shopify-proxy-provider"]?.trim();
	const org = headers["anthropic-organization-id"]?.trim();
	const workspace = headers["anthropic-workspace-id"]?.trim();
	const edge = headers["cf-ray"]?.trim().split("-").at(1);
	const account = org ? (workspace ? `${org}/${workspace}` : org) : undefined;
	return {
		...(backend ? { backend } : {}),
		...(account ? { account } : {}),
		...(edge ? { edge } : {}),
	};
}

/** Whether a response said anything of who served it. */
export function saysWho(served: Served): boolean {
	return Boolean(served.backend || served.account || served.edge);
}

/** Whether two answers name the same server. */
export function sameServer(a: Served | undefined, b: Served): boolean {
	return (
		a !== undefined &&
		a.backend === b.backend &&
		a.account === b.account &&
		a.edge === b.edge
	);
}

/** A recorded entry's data, read back as who served it. */
export function servedFrom(data: unknown): Served | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const { backend, account, edge } = data as Record<string, unknown>;
	return {
		...(typeof backend === "string" ? { backend } : {}),
		...(typeof account === "string" ? { account } : {}),
		...(typeof edge === "string" ? { edge } : {}),
	};
}
