/**
 * A review lens, authored as prose.
 *
 * A persona is what makes six reviewers worth more than one reviewer
 * asked six times: they read the same change looking for different
 * things. The lens is prose because that is what shapes a reader, and
 * because a lens somebody can argue with in a text editor is a lens
 * that gets better.
 *
 * The frontmatter is identity and carries no mechanism. Which model a
 * persona runs on, how hard it thinks and what tools it can reach are
 * decisions about cost and capability, and they belong in the roster
 * beside the other participants rather than buried in a charter. The
 * same lens at two thinking levels is two roster entries, not two
 * files.
 *
 * Reading the file is somebody else's job. This module is handed the
 * text, so the analysis can be tested without a directory and the
 * question of where personas live stays where the answer differs.
 */

import type { Participant } from "./identity.js";
import type { Roster } from "./roster.js";

/** A lens a reviewer reads through. */
export interface Persona {
	/** Stable id, which is the file's name. */
	id: string;
	name: string;
	description: string;
	/** The charter prose: the file body, frontmatter stripped. */
	charter: string;
}

/** A persona, or why it could not be read. */
export type PersonaParse = { persona: Persona } | { refusal: string };

/** Where a charter comes from, by persona id. */
export type CharterLookup = (personaId: string) => string | undefined;

/** A participant and the charter it reads through, if any. */
export interface PersonaBinding {
	participant: Participant;
	charter?: string;
}

/** Every participant bound to its charter, or why not. */
export type PersonaBind = { bindings: PersonaBinding[] } | { refusal: string };

/** The line that opens and closes a frontmatter block. */
const FENCE = "---";

/**
 * Read a persona file.
 *
 * The id comes from the caller rather than the file, because the id
 * has to be unique and only the directory can enforce that: two files
 * cannot share a name, and nothing written inside a file can promise
 * the same.
 */
export function parsePersona(id: string, text: string): PersonaParse {
	const split = splitFrontmatter(text);
	if (split === undefined) {
		return {
			refusal: `The persona "${id}" has no frontmatter block, so it names no lens. A persona opens with ${FENCE}, a name and a description, and closes with ${FENCE} before its charter.`,
		};
	}

	const name = split.fields.name;
	if (name === undefined || name === "") {
		return {
			refusal: `The persona "${id}" gives no name in its frontmatter, so there is nothing to call it.`,
		};
	}

	const description = split.fields.description;
	if (description === undefined || description === "") {
		return {
			refusal: `The persona "${id}" gives no description in its frontmatter. The description is how somebody choosing a roster knows what this lens is for.`,
		};
	}

	const charter = split.body.trim();
	if (charter === "") {
		// A named lens with nothing behind it is worse than no persona:
		// the roster reads as though a specialist is on it.
		return {
			refusal: `The persona "${id}" has an empty charter, so it is a name for a lens that does not exist. The body of the file is what shapes the reviewer.`,
		};
	}

	return { persona: { id, name, description, charter } };
}

/**
 * Bind every participant in a roster to the charter it names.
 *
 * A missing persona is a refusal rather than a fallback. A reviewer
 * meant to be a security lens that silently became a generic one still
 * files its findings under the name "security", and whoever reads them
 * afterwards weighs them as a specialist's. Better to say the file is
 * missing than to quietly answer a different question.
 */
export function bindPersonas(
	roster: Roster,
	lookup: CharterLookup,
): PersonaBind {
	const participants = [
		...roster.reviewers,
		...(roster.judge === undefined ? [] : [roster.judge]),
	];

	const bindings: PersonaBinding[] = [];
	for (const participant of participants) {
		if (participant.persona === undefined) {
			bindings.push({ participant });
			continue;
		}
		const charter = lookup(participant.persona);
		if (charter === undefined) {
			return {
				refusal: `The participant "${participant.id}" names the persona "${participant.persona}", and no such persona could be read. Add it, or drop the persona from this participant: running it without its lens would file generic findings under a specialist's name.`,
			};
		}
		bindings.push({ participant, charter });
	}
	return { bindings };
}

/**
 * The frontmatter fields and the body after them, or nothing.
 *
 * Exported within the module rather than kept private, because the
 * repo-agent reader needs the same split and needs the raw fields
 * besides: it reports which of them it declined to adopt, and a parse
 * that hands back only a `Persona` has already thrown those away.
 * Deliberately not in the barrel, since the frontmatter contract is
 * this module's business and not a consumer's.
 */
export function splitFrontmatter(
	text: string,
): { fields: Record<string, string>; body: string } | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== FENCE) return undefined;

	const close = lines.findIndex((line, at) => at > 0 && line.trim() === FENCE);
	if (close === -1) return undefined;

	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const at = line.indexOf(":");
		if (at === -1) continue;
		const key = line.slice(0, at).trim();
		if (key === "") continue;
		fields[key] = line.slice(at + 1).trim();
	}

	return { fields, body: lines.slice(close + 1).join("\n") };
}
