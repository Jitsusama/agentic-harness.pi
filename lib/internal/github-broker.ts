/**
 * GitHub tokens for the sandbox, an hour each, from the machine's
 * github-broker.
 *
 * The broker holds a GitHub App whose tokens can read code and open and
 * comment on pull requests and issues, and nothing more: never push,
 * merge or change a setting. Its socket is one the sandbox leaves out, so
 * pi asks it here, outside the fence, and hands a command only the token.
 * A machine without the broker, or before its App is made, gives none, and
 * commands run without GitHub as they did before.
 */

import { execFileSync } from "node:child_process";

/** The program that asks the broker, which a workstation puts on PATH. */
export const GITHUB_BROKER = "github-broker";

/**
 * How long one answer is used before asking again. The broker hands out
 * tokens with ten minutes or more left, so one used for five never reaches
 * a command spent; asking again sooner would only spawn more processes.
 */
export const ASK_EVERY_MS = 5 * 60_000;

/** How long the broker has to answer before a command runs without it. */
const PATIENCE_MS = 10_000;

/**
 * A token as GitHub mints one. An App's installation token runs to about
 * 390 characters and holds dots and dashes as well as letters, digits and
 * underscores, none of which a shell reads as anything but itself.
 */
const TOKEN = /^[A-Za-z0-9_.-]{20,1024}$/;

/** Gives a GitHub token for a sandboxed command, or nothing. */
export type GitHubTokenSource = () => string | undefined;

/** Asks the broker for a token, throwing when it gives none. */
export type BrokerAsk = () => string;

/** Runs `github-broker`, which prints a token, or fails saying why. */
function askTheBroker(): string {
	return execFileSync(GITHUB_BROKER, [], {
		encoding: "utf8",
		timeout: PATIENCE_MS,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * A source that asks the broker at most once every five minutes, keeping
 * its answer, a refusal included, so a machine without one pays a failed
 * spawn a few times an hour rather than once a command.
 */
export function brokerTokens(
	ask: BrokerAsk = askTheBroker,
	now: () => number = Date.now,
): GitHubTokenSource {
	let held: { token: string | undefined; at: number } | undefined;
	return () => {
		const at = now();
		if (held && at - held.at < ASK_EVERY_MS) return held.token;
		let token: string | undefined;
		try {
			const answer = ask().trim();
			token = TOKEN.test(answer) ? answer : undefined;
		} catch {
			// No broker on this machine, no App made yet, or GitHub said no:
			// commands run without GitHub, as they do without a broker.
			token = undefined;
		}
		held = { token, at };
		return token;
	};
}
