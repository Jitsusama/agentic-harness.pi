/**
 * Delta's token for the agent fence, minted outside it by mint.
 *
 * World's `dt`, and `devx ci`, take a bearer for Delta from `WGH_TOKEN`
 * when `WGH_HOST` names Delta, and send it to Delta alone, handing git
 * its share as an `http.extraHeader` through the environment, never on
 * a command line (World's `system/scm/delta/docs/CLI.md`). Inside the
 * fence they otherwise find no credential, since mint, which mints one,
 * answers only outside, and dev's token cache is hidden: so a fenced
 * session could neither read a pull request nor push a branch with them.
 *
 * So pi asks mint here, outside, and hands each fenced command the token
 * and the host. It is a Minerva token for Delta as the person, writing
 * included, for up to a day: less than an unfenced session holds, which
 * is the whole token cache, but more than the GitHub door gives, which
 * keeps its token outside. That risk is recorded (ISXEG8, 23 November)
 * and closes once Delta stands behind the door the way GitHub does, the
 * command holding only a stand-in. A machine without mint, or whose mint
 * gives none, hands none, and dt inside fails as it did before.
 */

import { execFileSync } from "node:child_process";
import {
	noOwner,
	noOwnerFix,
	noOwnerSaid,
	systemFolders,
	systemProgram,
} from "./system-program.ts";

/** Delta's host, as `WGH_HOST` names it, and the destination mint takes. */
export const DELTA_HOST = "delta.shopify.io";

/**
 * Where mint lies: dev's installer puts it in `/usr/local/bin`, which
 * only root writes, and never in the system's own profiles.
 */
const MINT_FOLDERS = ["/usr/local/bin"] as const;

/**
 * How long one answer is used before asking again. mint keeps its own
 * token until it is nearly spent, so asking costs a few milliseconds,
 * and asking every quarter hour notices a fresh login soon.
 */
export const ASK_EVERY_MS = 15 * 60_000;

/**
 * The least a token must have left to be handed on. A command started
 * with it may run for hours, so one with less is minted fresh.
 */
export const FRESH_BELOW_MS = 2 * 60 * 60_000;

/**
 * How long mint has to answer before a command runs without it. The
 * call holds pi's shared host while it waits, and mint answers in under
 * half a second even when it mints afresh, so a hung mint costs the
 * host at most four seconds a quarter hour.
 */
const PATIENCE_MS = 2000;

/** A JWT: three base64url parts, each letters, digits, `-` and `_`. */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The longest token taken, well past a Minerva token's 1 to 2 KiB. */
const LONGEST = 8192;

/** Gives Delta's token for a fenced command, or nothing. */
export type DeltaTokenSource = () => string | undefined;

/** Asks mint for Delta's token, fresh or from its cache, throwing when it gives none. */
export type MintAsk = (fresh: boolean) => string;

/**
 * What mint runs with: who it runs as and where its broker listens, and
 * a `PATH` of the system's own folders alone. pi's own `PATH` can hold a
 * folder a fenced command writes, such as a project's `.direnv/bin`, and
 * mint, run outside the fence, would find a program planted there.
 */
export function mintEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	folders: readonly string[] = systemFolders(),
): NodeJS.ProcessEnv {
	const kept = ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "LANG"];
	return {
		...Object.fromEntries(
			kept.flatMap((name) => {
				const value = env[name];
				return value === undefined ? [] : [[name, value]];
			}),
		),
		PATH: folders.join(":"),
	};
}

/**
 * Runs mint from where only root puts it, or throws when it isn't there.
 * It runs while pi waits, at most twice a quarter hour and up to
 * `PATIENCE_MS` each; mint answers from its cache in a few milliseconds.
 */
function askMint(fresh: boolean): string {
	const mint = systemProgram("mint", MINT_FOLDERS);
	if (!mint) {
		const why = noOwner();
		throw new Error(
			why
				? `no mint found: ${noOwnerSaid(why)}. ${noOwnerFix(why)}`
				: "no mint where only root puts it",
		);
	}
	return execFileSync(
		mint,
		["token", DELTA_HOST, ...(fresh ? ["--fresh"] : [])],
		{
			encoding: "utf8",
			timeout: PATIENCE_MS,
			stdio: ["ignore", "pipe", "ignore"],
			env: mintEnvironment(),
		},
	);
}

/**
 * When `token` runs out, in milliseconds, read from its claims; nothing
 * when it isn't a JWT or names no expiry. The signature isn't checked:
 * Delta checks it, and this only says when to ask again.
 */
export function expiresAt(token: string): number | undefined {
	if (token.length > LONGEST || !JWT.test(token)) return undefined;
	const claims = token.split(".")[1] ?? "";
	try {
		const exp: unknown = JSON.parse(
			Buffer.from(claims, "base64url").toString("utf8"),
		)?.exp;
		return typeof exp === "number" && Number.isFinite(exp)
			? exp * 1000
			: undefined;
	} catch {
		// Claims that aren't JSON: not a token to hand on.
		return undefined;
	}
}

/**
 * A source that asks mint at most once a quarter hour, keeping its
 * answer, a refusal included, so a machine without mint pays a failed
 * lookup a few times an hour rather than once a command. A token with
 * under two hours left is minted fresh; when that fails, the one in hand
 * serves until the quarter hour or its expiry, whichever is sooner, so a
 * failing mint is asked no more often than a working one. A token that
 * is spent, or isn't a JWT, is never handed on.
 */
export function deltaTokens(
	ask: MintAsk = askMint,
	now: () => number = Date.now,
): DeltaTokenSource {
	let held: { token: string | undefined; until: number } | undefined;
	const lasting = (token: string | undefined, at: number) =>
		token !== undefined && (expiresAt(token) ?? 0) - at >= FRESH_BELOW_MS;
	return () => {
		const at = now();
		if (held && at < held.until) return held.token;
		let token = tried(ask, false);
		// A fresh one only replaces it when one comes: a token with an hour
		// left still serves a command that ends sooner.
		if (!lasting(token, at)) token = tried(ask, true) ?? token;
		const expiry = token === undefined ? 0 : (expiresAt(token) ?? 0);
		const handed = expiry > at ? token : undefined;
		const next = at + ASK_EVERY_MS;
		const until =
			handed === undefined
				? next
				: Math.min(
						next,
						lasting(handed, at) ? expiry - FRESH_BELOW_MS : expiry,
					);
		held = { token: handed, until };
		return handed;
	};
}

/** mint's answer, trimmed, or nothing when it gives none. */
function tried(ask: MintAsk, fresh: boolean): string | undefined {
	try {
		const answer = ask(fresh).trim();
		return expiresAt(answer) === undefined ? undefined : answer;
	} catch {
		// No mint on this machine, its service down, or the broker said no:
		// commands run without Delta, as they did before.
		return undefined;
	}
}

/** What a fenced command is handed for Delta, given `token`. */
export function deltaVariables(
	token: string | undefined,
): Record<string, string> {
	return token ? { WGH_TOKEN: token, WGH_HOST: DELTA_HOST } : {};
}
