/**
 * The work host's gateway key, kept current for a host that outlives it.
 *
 * The work launcher resolves one key at start and execs pi, which is
 * enough for a conversation but not for a host: the personal key expires
 * about daily, and the dev daemon renews it in its encrypted cache ahead
 * of that. So the host resolves the key the way the launcher does, keeps
 * it beside the cache's plaintext expiry stamp, and resolves it again
 * when the stamp moves, when the expiry is near, or once after the
 * gateway refuses it. A failed resolve fails the request with the dev
 * tool's own cure; it never falls back to another key.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** How long before the stamped expiry a key is resolved afresh. */
const RENEW_LEAD_MS = 10 * 60 * 1000;

/** How long one resolve may take before it counts as failed. */
const RESOLVE_TIMEOUT_MS = 30_000;

/** A resolver's answer: the key's text, never logged or returned whole. */
export type ResolveKey = () => Promise<string>;

/** The host's view of its one gateway key. */
export interface GatewayKey {
	/** The key every provider request uses now, resolving it when due. */
	current(): Promise<string>;
	/** Say the gateway refused the key, so the next request resolves again. */
	refused(): void;
	/** Whether the key came from the host's environment and never renews. */
	readonly inherited: boolean;
}

/** What a gateway key is read from. */
export interface GatewayKeyOptions {
	/** The host's environment, checked in the launcher's order. */
	env: NodeJS.ProcessEnv;
	/** Resolves the cached personal key; defaults to the dev tool. */
	resolve?: ResolveKey;
	/** The cache's plaintext expiry stamp. */
	stampFile?: string;
	/** The clock, for tests. */
	now?: () => number;
}

/**
 * The key a host's provider requests use. A usable key in the host's
 * environment wins and stays fixed, as the launcher treats it; otherwise
 * the personal key is resolved through the dev tool and renewed as its
 * cache stamp says.
 */
export function gatewayKey(options: GatewayKeyOptions): GatewayKey {
	const fixed = inheritedKey(options.env);
	if (fixed !== undefined) {
		return {
			inherited: true,
			current: () => Promise.resolve(fixed),
			refused: () => {
				// An inherited key has no renewal source; the refusal reaches
				// the request as it is.
			},
		};
	}
	return renewingKey(
		options.resolve ?? printToken,
		options.stampFile ?? defaultStampFile(options.env),
		options.now ?? Date.now,
	);
}

/** One resolved key and the stamp it was read beside. */
interface Held {
	key: string;
	stamp: string | undefined;
}

function renewingKey(
	resolve: ResolveKey,
	stampFile: string,
	now: () => number,
): GatewayKey {
	let held: Held | undefined;
	let pending: Promise<string> | undefined;
	let refusedSince = false;

	const renew = async (): Promise<string> => {
		const stamp = await readStamp(stampFile);
		const key = await resolve();
		held = { key, stamp };
		refusedSince = false;
		return key;
	};

	return {
		inherited: false,
		async current() {
			if (pending) return pending;
			const stamp = await readStamp(stampFile);
			if (held && !refusedSince && !due(held, stamp, now())) return held.key;
			// Another request may have started a resolve while the stamp was read.
			if (pending) return pending;
			pending = renew().finally(() => {
				pending = undefined;
			});
			return pending;
		},
		refused() {
			refusedSince = true;
		},
	};
}

/** Whether a held key must be resolved again before it is used. */
function due(held: Held, stamp: string | undefined, at: number): boolean {
	if (stamp === undefined) return true;
	if (stamp !== held.stamp) return true;
	const expires = Date.parse(stamp);
	if (Number.isNaN(expires)) return true;
	return expires - at < RENEW_LEAD_MS;
}

async function readStamp(file: string): Promise<string | undefined> {
	try {
		return (await readFile(file, "utf8")).trim();
	} catch {
		// No stamp is an unknown expiry, which resolves on every request
		// rather than trusting a key nothing dates.
		return undefined;
	}
}

/** The launcher's inherited key, in its order: legacy, bearer, canonical. */
function inheritedKey(env: NodeJS.ProcessEnv): string | undefined {
	const legacy = usable(env.PI_PROXY_API_KEY);
	if (legacy) return legacy;
	const header = env.PI_PROXY_AUTH_HEADER?.trim();
	if (header?.startsWith("Bearer ")) {
		const bearer = usable(header.slice("Bearer ".length));
		if (bearer) return bearer;
	}
	return usable(env.SHOPIFY_PROXY_KEY);
}

function usable(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("!")) return undefined;
	return trimmed;
}

function defaultStampFile(env: NodeJS.ProcessEnv): string {
	return join(
		env.HOME ?? homedir(),
		".cache",
		"dev",
		"tokens",
		"llm_gateway",
		"expires_at",
	);
}

/** The launcher's own resolver: the dev tool prints the cached key. */
function printToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"devx",
			["llm-gateway", "print-token", "--key"],
			{ timeout: RESOLVE_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout, stderr) => {
				const key = stdout.trim();
				if (error || !key) {
					reject(new Error(resolveFailure(stderr, error)));
					return;
				}
				resolve(key);
			},
		);
	});
}

function resolveFailure(stderr: string, error: Error | null): string {
	const said = stderr.trim().split("\n").filter(Boolean).at(-1);
	const why = said ?? error?.message ?? "it printed no key";
	return `Gateway key could not be resolved: ${why}`;
}
