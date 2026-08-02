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
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Files this gate reads: the library and the extensions, no tests. */
function sources(): string[] {
	const listed = execFileSync(
		"git",
		["ls-files", "lib/**/*.ts", "extensions/**/*.ts"],
		{ encoding: "utf8" },
	);
	return listed.split("\n").filter((path) => path !== "");
}

/** Every line putting a remote into a template literal. */
function mentions(): Mention[] {
	const found: Mention[] = [];
	for (const where of sources()) {
		const lines = readFileSync(where, "utf8").split("\n");
		lines.forEach((text, index) => {
			if (INTERPOLATED.test(text)) {
				found.push({ where, line: index + 1, text: text.trim() });
			}
		});
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
		// against something real. Exactly one site interpolates a remote
		// today. The other leak this was written for, a refusal naming the
		// checkout it was steered away from, is not counted here: it takes
		// the credential out where the remote enters the pair, so by the
		// time there is a string there is nothing left to catch. That is
		// the better fix and the reason this number is one rather than two.
		expect(mentions().length).toBeGreaterThanOrEqual(1);
	});
});
