/**
 * A remote URL reaches a person with no credential in it.
 *
 * A remote that authenticates inline carries the token in the URL, and git
 * accepts it as either the user or the password. So a message that names the
 * remote verbatim prints a live secret into the transcript, into whatever log
 * keeps it, and into whatever the person reading it pastes somewhere else.
 * That is not hypothetical: a refusal about the wrong repo did exactly this,
 * which is why the gate exists.
 *
 * The check is coarse, because a string is only a leak once someone reads it,
 * and nothing static knows that. It asks a narrower question with a reliable
 * answer: is a remote being interpolated into a message without going through
 * the one function that makes one safe to say. Passing is not proof of no
 * leak. Failing is very nearly proof of one.
 *
 * Ported from agentic-harness.pi's own gate, which watched `lib/` and
 * `extensions/`; the one site it was written against, a work provider's
 * refusal naming an unregistered repo's remote, moved here along with
 * `lib/work`. Scoped to `review` and `work`, the two domains that ever
 * carry a `remoteUrl` into a message.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** A place a remote is interpolated into a string. */
interface Mention {
	where: string;
	line: number;
	text: string;
}

/** The function that makes a remote safe to say. */
const LAUNDERED = "withoutCredentials";

/**
 * Interpolations of something whose name ends in a remote URL.
 *
 * The name is the signal. A value called `remoteUrl` holds one, and the
 * convention is consistent enough across both domains to key on.
 */
const INTERPOLATED = /\$\{[^}]*\b\w*[rR]emoteUrl\b[^}]*\}/;

/** Libraries this gate reads. */
const WATCHED = ["lib/core/review", "lib/core/work"];

/** Every `.ts` file under a directory, recursively. */
function sourcesUnder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourcesUnder(path));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** Every line putting a remote into a template literal. */
function mentions(): Mention[] {
	const found: Mention[] = [];
	for (const lib of WATCHED) {
		for (const where of sourcesUnder(join(process.cwd(), lib))) {
			const lines = readFileSync(where, "utf8").split("\n");
			lines.forEach((text, index) => {
				if (INTERPOLATED.test(text)) {
					found.push({ where, line: index + 1, text: text.trim() });
				}
			});
		}
	}
	return found;
}

describe("a remote said to a person", () => {
	it("goes through the one function that takes the credential out", () => {
		const raw = mentions().filter((m) => !m.text.includes(LAUNDERED));

		expect(
			raw.map((m) => `${m.where}:${m.line}\n    ${m.text}`),
			`These interpolate a remote URL without ${LAUNDERED}. A remote can ` +
				`carry a token as its user or its password, so one printed as it ` +
				`is puts a live secret in the transcript. Wrap it, or if this ` +
				`string is handed to git rather than to a person, keep the ` +
				`credential and name the value so it does not read as a message.`,
		).toEqual([]);
	});

	it("finds the place it is meant to be watching", () => {
		// A gate that matches nothing passes forever, so it has to be held
		// against something real.
		expect(mentions().length).toBeGreaterThanOrEqual(1);
	});
});
