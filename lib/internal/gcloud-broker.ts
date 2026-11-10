/**
 * Google Cloud tokens for the sandbox, an hour each, from the machine's
 * gcloud-broker.
 *
 * The person's own cloud login reaches every project they can, so it stays
 * out of the fence. A machine that names an account for its agents gets
 * `gcloud-broker`, which mints that account's tokens with the person's
 * login, outside the fence, and says the one project the account is made
 * in. pi asks it here and hands a command only the token and the project,
 * so gcloud inside acts as the account and can't reach past what it was
 * granted. A machine without the broker gives none, and gcloud inside
 * finds no login, as it did before.
 *
 * A token takes gcloud 7 to 15 s to mint, so the broker is asked in the
 * background and a command is handed what the last answer was, never made
 * to wait. The first command of a session starts the first ask, and one
 * that names gcloud before it's answered is told why it has no token.
 */

import { execFile } from "node:child_process";

/** The program that asks the broker, which a machine naming an account puts on PATH. */
export const GCLOUD_BROKER = "gcloud-broker";

/**
 * How long one answer stands before asking again. The broker keeps a token
 * for 45 minutes of its hour, so one used for five more never reaches a
 * command spent; asking sooner would only spawn more processes.
 */
export const ASK_EVERY_MS = 5 * 60_000;

/**
 * How long an answer is handed on while its next is being asked for: twice
 * the asking, so a slow mint doesn't leave commands without one, and still
 * short of the ten minutes a token kept 45 has left.
 */
export const USED_FOR_MS = 2 * ASK_EVERY_MS;

/** How long the broker has, past gcloud's own minute, before it counts as refused. */
const PATIENCE_MS = 75_000;

/** A token as Google mints one; the broker refuses any other shape too. */
const TOKEN = /^[A-Za-z0-9._-]{20,4096}$/;

/** A project's id, as Google allows one. */
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The longest refusal passed on, as the broker's own are. */
const REASON_LENGTH = 300;

/** What a sandboxed command is handed for gcloud: a token and its project, or why not. */
export type CloudGrant =
	| { readonly token: string; readonly project: string }
	| { readonly reason: string };

/** Gives what a sandboxed command is handed for gcloud, now, without waiting. */
export type CloudGrantSource = () => CloudGrant;

/**
 * Asks the broker one thing, answering what it printed, or failing with
 * how running it failed: its `code` or `killed` as node's spawning says
 * them, and what it said on stderr as `said`.
 */
export type CloudAsk = (verb: "access" | "project") => Promise<string>;

/** Why the broker gave nothing, in a line, from how asking it failed. */
function refusal(error: unknown): string {
	if (!(error instanceof Error)) return `${GCLOUD_BROKER} refused`;
	if ("code" in error && error.code === "ENOENT") {
		return `${GCLOUD_BROKER} isn't on this machine, which names no cloud account for its agents`;
	}
	if ("killed" in error && error.killed) {
		return `${GCLOUD_BROKER} didn't answer within ${PATIENCE_MS / 1000} s`;
	}
	// The broker says why on stderr's last line, which never holds a token.
	const said =
		"said" in error && typeof error.said === "string" ? error.said : "";
	const line = said.trim().split("\n").at(-1)?.trim() || error.message.trim();
	return line ? line.slice(0, REASON_LENGTH) : `${GCLOUD_BROKER} refused`;
}

/** Runs `gcloud-broker <verb>`, which prints its answer alone, or fails saying why on stderr. */
function askTheBroker(verb: "access" | "project"): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			GCLOUD_BROKER,
			[verb],
			{ encoding: "utf8", timeout: PATIENCE_MS },
			(error, stdout, stderr) => {
				if (error) reject(Object.assign(error, { said: stderr }));
				else resolve(stdout);
			},
		);
	});
}

/** The project and a token, or why there are none, from one round of asking. */
async function grantFrom(ask: CloudAsk): Promise<CloudGrant> {
	try {
		const project = (await ask("project")).trim();
		if (!PROJECT.test(project)) {
			return { reason: `${GCLOUD_BROKER} named no project` };
		}
		const token = (await ask("access")).trim();
		if (!TOKEN.test(token)) {
			return { reason: `${GCLOUD_BROKER} answered without a token` };
		}
		return { token, project };
	} catch (error) {
		return { reason: refusal(error) };
	}
}

/**
 * A source that asks the broker at most once every five minutes, in the
 * background, keeping its answer, a refusal included, so a machine without
 * one pays a failed spawn a few times an hour rather than once a command.
 */
export function cloudGrants(
	ask: CloudAsk = askTheBroker,
	now: () => number = Date.now,
): CloudGrantSource {
	let held: { grant: CloudGrant; at: number } | undefined;
	let asking = false;
	const askAgain = () => {
		asking = true;
		void grantFrom(ask).then((grant) => {
			held = { grant, at: now() };
			asking = false;
		});
	};
	return () => {
		const age = held ? now() - held.at : Number.POSITIVE_INFINITY;
		if (age >= ASK_EVERY_MS && !asking) askAgain();
		if (held && age < USED_FOR_MS) return held.grant;
		if (held && "reason" in held.grant) return held.grant;
		const which = held ? "a fresh token" : "this session's first token";
		return {
			reason: `${GCLOUD_BROKER} is still minting ${which}, which takes gcloud up to 15 s; try again shortly`,
		};
	};
}

/** Whether a command names one of the cloud's own programs, which need a token. */
export function namesTheCloud(command: string): boolean {
	return /(^|[^\w.-])(gcloud|gsutil|bq)($|[^\w.-])/.test(command);
}
