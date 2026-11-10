/**
 * SHOPIFY_HARNESS_SETTINGS as one hosted conversation's launch says it.
 *
 * Shopify's launcher writes this variable once per pi it starts, saying
 * how that pi was launched, and ai-proxy-headers copies it into each
 * request's Shopify-Request-Context as harness_settings. A shared host
 * is launched once but opens many conversations, each attended or in
 * the background, fresh or resumed, some naming their model. So the
 * engine builds each conversation's value from the host's own, saying
 * what differs for that conversation and keeping what the host's launch
 * checked (the router opt-out, the saved reasoning, what config was
 * read), which holds for every conversation it runs.
 */

import { VERSION } from "@earendil-works/pi-coding-agent";

/** The variable Shopify's launcher and ai-proxy-headers share. */
export const HARNESS_SETTINGS_VARIABLE = "SHOPIFY_HARNESS_SETTINGS";

/** What the host knows of a conversation, whatever opened it. */
export interface HarnessTraits {
	readonly attended: boolean;
}

/** The request that brought a conversation into the host, as far as this reads it. */
export type HarnessRequest =
	| {
			readonly op: "open";
			readonly model?: unknown;
			readonly thinkingLevel?: string;
	  }
	| { readonly op: "adopt" };

/**
 * The conversation's SHOPIFY_HARNESS_SETTINGS, from the host's value
 * (if any), its traits and the request that brought it in. With no
 * request the host is carrying it on from before a restart, so the
 * model and reasoning sources stay as the host's value says them.
 */
export function harnessSettings(
	base: string | undefined,
	traits: HarnessTraits,
	request?: HarnessRequest,
): string {
	const host = parsed(base);
	const settings: Record<string, unknown> = {
		...host,
		v: "1",
		harness: "pi",
		// The pi the host runs the conversation on, whatever launched the host.
		harness_version: VERSION,
		surface: traits.attended ? "interactive" : "background",
		launch_mode: launchMode(request),
	};
	if (request?.op === "open") {
		settings.model_source = request.model === undefined ? "default" : "cli";
		settings.reasoning_source =
			request.thinkingLevel === undefined ? "default" : "cli";
	}
	return JSON.stringify(sorted(settings));
}

function launchMode(request: HarnessRequest | undefined): string {
	if (request === undefined) return "restore";
	return request.op === "open" ? "fresh" : "resume";
}

/** The host's value as an object, or nothing when it is missing or not one. */
function parsed(base: string | undefined): Record<string, unknown> {
	if (!base) return {};
	try {
		const value: unknown = JSON.parse(base);
		return isRecord(value) ? value : {};
	} catch {
		// A value the launcher didn't write is no base; the conversation's
		// own traits still say how it was launched.
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys in order, as the launcher writes them, so equal settings read alike. */
function sorted(settings: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(settings).sort(([a], [b]) => a.localeCompare(b, "en")),
	);
}
