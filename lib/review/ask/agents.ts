/**
 * Agents another harness already defined in the repo under review.
 *
 * A repo that has been worked in for a while has usually accumulated
 * some: a reviewer, an architect, a debugger, each written by somebody
 * who knew that codebase. They are lenses, which is what a persona is,
 * and they are already there, which is more than can be said for any
 * lens this tool ships. Offering them costs a directory read.
 *
 * Three rules make that safe, and the third is the one that matters.
 *
 * They are namespaced, because a roster naming a lens and silently
 * getting the repo's version of it is the quiet substitution
 * `bindPersonas` refuses: the findings still file under the name, and
 * whoever reads them weighs them as the lens they asked for.
 *
 * Only the prose comes across. Measured across fifteen agent files on
 * this machine, thirteen name tools and six name a model, in
 * vocabulary that belongs to the harness that wrote them: `sonnet` is
 * not a model pi resolves and `Bash, Read, Edit` are not tools it has.
 *
 * And the change under review may not be the thing that wrote them. A
 * charter becomes the reviewer's `--system-prompt`, on a child holding
 * bash and write, with its working directory inside the tree, and that
 * tree is pinned to the commit under review. So without this rule the
 * author of a change writes the standing instruction of the agent
 * reviewing it, and the operator's consent is worth little, since the
 * listing they chose from read a different tree. A lens the diff
 * touches is refused. What remains is the repo's committed state,
 * which is the same trust already extended to every other line in it.
 *
 * Reading the directory is somebody else's job, as it is for personas.
 * This module is handed the files.
 */

import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "./persona.js";

/** A file that might describe an agent. */
export interface AgentFile {
	/** Where it was found, relative to the repo, for reporting. */
	path: string;
	text: string;
}

/** A lens the repo under review already had. */
export interface RepoAgent {
	/** Namespaced id, which is how a roster asks for it. */
	id: string;
	name: string;
	description: string;
	/** The charter prose: the file body, frontmatter stripped. */
	charter: string;
	source: string;
	/** Frontmatter fields deliberately left behind, if any. */
	notAdopted?: string[];
}

/** What a directory of agent files yielded, and what it did not. */
export interface AgentDiscovery {
	agents: RepoAgent[];
	skipped: { path: string; why: string }[];
}

/** The prefix that keeps these out of the persona namespace. */
export const NAMESPACE = "repo:";

/**
 * How much charter a lens may carry.
 *
 * A charter becomes an argument on a child process, so unbounded is
 * not a size, it is a limit somebody else picks. The longest agent
 * file measured on this machine is 926 lines, which fits; a file that
 * does not is refused rather than truncated, since half a charter is a
 * lens nobody wrote.
 */
const MOST_CHARTER = 64_000;

/**
 * Whether a path from a diff and a path from a directory walk name the
 * same file.
 *
 * Exact equality was the first shape, and a diff does not promise the
 * spelling a directory walk produces: git quotes a path with an
 * unusual byte in it, and separators differ by platform. A comparison
 * that is too strict fails open here, which is the wrong direction for
 * the one rule that keeps the change under review out of the
 * reviewer's prompt.
 */
function sameFile(fromDiff: string, found: string): boolean {
	return plain(fromDiff) === plain(found);
}

/** A path reduced to what two spellings of it agree on. */
function plain(path: string): string {
	const unquoted =
		path.startsWith('"') && path.endsWith('"')
			? unquote(path.slice(1, -1))
			: path;
	return unquoted.replace(/\\/g, "/").replace(/^\.\//, "").normalize("NFC");
}

/**
 * A path the way git quotes one, read back.
 *
 * Byte by byte rather than character by character, because git escapes
 * the bytes: an accented letter arrives as two octal escapes that are
 * one character, and decoding them separately produces a string that
 * matches nothing on disk.
 */
function unquote(quoted: string): string {
	const bytes: number[] = [];
	for (let at = 0; at < quoted.length; at += 1) {
		if (quoted[at] !== "\\") {
			bytes.push(...new TextEncoder().encode(quoted[at]));
			continue;
		}
		const octal = quoted.slice(at + 1, at + 4);
		if (/^[0-7]{3}$/.test(octal)) {
			bytes.push(Number.parseInt(octal, 8));
			at += 3;
			continue;
		}
		const escaped = quoted[at + 1] ?? "";
		const literal = { n: "\n", t: "\t", r: "\r" }[escaped] ?? escaped;
		bytes.push(...new TextEncoder().encode(literal));
		at += 1;
	}
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * The frontmatter of an agent file, read as the YAML it is.
 *
 * The persona reader splits on the first colon of each line, which is
 * enough for files this project's own contract governs. These files
 * are not that: they are written for another harness, in real YAML,
 * and the descriptions on this machine run to a paragraph with colons
 * in them. A line splitter turns a quoted or folded value into
 * something that parses and is wrong, which is worse than refusing.
 *
 * Only scalars are taken. A nested value is not a name or a
 * description, and reporting it as one would put a `[object Object]`
 * in a listing somebody chooses from.
 */
function frontmatterOf(
	text: string,
):
	| { fields: Record<string, string>; unreadable: string[]; body: string }
	| { why: string }
	| undefined {
	const split = splitFrontmatter(text);
	if (split === undefined) return undefined;

	let parsed: unknown;
	try {
		// The block the split itself found. Finding the fences a second
		// way put whatever fell between the two rules into neither the
		// fields nor the listing, and at the head of the charter.
		parsed = parseYaml(split.block);
	} catch (error) {
		return {
			why: `Its frontmatter is not readable as YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { why: "Its frontmatter is not a block of fields." };
	}

	const fields: Record<string, string> = {};
	const unreadable: string[] = [];
	for (const [key, value] of Object.entries(parsed)) {
		// Named before it is dropped. Dropping first left the report of
		// what was not adopted silent about exactly the fields it promises
		// to name, because it never saw them.
		if (value === null || typeof value === "object") {
			unreadable.push(key);
			continue;
		}
		fields[key] = String(value).trim();
	}
	return { fields, unreadable, body: split.body };
}

/**
 * The two fields identity is made of.
 *
 * Everything else in the frontmatter belongs to the harness the file
 * was written for, and is reported rather than adopted: the file is
 * not wrong, it is right for something else. An allowlist of the
 * mechanism seen so far was the first shape of this, and it named the
 * fields already known about while staying silent on whatever a
 * harness adds next, which is the reverse of what a report is for.
 */
const IDENTITY = ["name", "description"];

/**
 * Read what a repo's agent files offer.
 *
 * Lenient where the persona reader is strict, and the difference is
 * who asked. A persona is named in somebody's own config, so a
 * malformed one is a mistake they want reported loudly. Nobody asked
 * for these, so one malformed file in a repo this operator does not
 * maintain must not refuse every round run against it.
 */
export function discoverAgents(
	files: AgentFile[],
	// Paths the change under review touches. A lens among them is
	// refused rather than dropped quietly, because somebody asking for
	// it by name has to learn that it was the diff that disqualified it
	// and not a typo.
	//
	// Required, and deliberately so. It defaulted to the empty set at
	// first, which meant the rule the whole design rests on was off
	// unless a caller remembered to switch it on, and a caller that
	// forgot got the unsafe behaviour silently. Pass an empty array to
	// say the change touches nothing.
	touched: readonly string[],
): AgentDiscovery {
	const read: RepoAgent[] = [];
	const skipped: { path: string; why: string }[] = [];
	const sourceOf = new Map<string, string[]>();

	for (const file of files) {
		const split = frontmatterOf(file.text);
		if (split === undefined) {
			skipped.push({
				path: file.path,
				why: "It opens with no frontmatter block, so it names no lens.",
			});
			continue;
		}
		if ("why" in split) {
			skipped.push({ path: file.path, why: split.why });
			continue;
		}

		const name = split.fields.name;
		if (name === undefined || name === "") {
			skipped.push({
				path: file.path,
				why: "Its frontmatter gives no name, so there is nothing to call it.",
			});
			continue;
		}

		const description = split.fields.description;
		if (description === undefined || description === "") {
			skipped.push({
				path: file.path,
				why: `The agent "${name}" gives no description, which is how somebody choosing a lens knows what it is for.`,
			});
			continue;
		}

		if (touched.some((path) => sameFile(path, file.path))) {
			skipped.push({
				path: file.path,
				why: `The change under review edits this file, so reading through "${name}" would let the author of the change write the reviewer's standing instruction.`,
			});
			continue;
		}

		const charter = split.body.trim();
		if (charter.length > MOST_CHARTER) {
			skipped.push({
				path: file.path,
				why: `The charter for "${name}" is ${charter.length} characters, past the ${MOST_CHARTER} a lens may carry. A charter becomes an argument on the reviewer's process.`,
			});
			continue;
		}
		if (charter === "") {
			skipped.push({
				path: file.path,
				why: `The agent "${name}" has an empty body, so it is a name for a lens that does not exist.`,
			});
			continue;
		}

		// Everything that is not identity, rather than a list of the two
		// fields seen so far. An allowlist reports the fields already known
		// about and stays silent on the ones a harness adds next, which is
		// the reverse of what a report is for.
		const notAdopted = [
			...Object.keys(split.fields).filter((field) => !IDENTITY.includes(field)),
			...split.unreadable,
		].sort();
		read.push({
			id: `${NAMESPACE}${name}`,
			name,
			description,
			charter,
			source: file.path,
			...(notAdopted.length === 0 ? {} : { notAdopted }),
		});
		sourceOf.set(name, [...(sourceOf.get(name) ?? []), file.path]);
	}

	// A name two files answer to identifies neither. Dropping both is
	// the only answer that does not make which lens ran depend on the
	// order a directory happened to list its entries.
	const contested = (one: RepoAgent) =>
		(sourceOf.get(one.name) ?? []).length > 1;
	for (const one of read.filter(contested)) {
		skipped.push({
			path: one.source,
			why: `"${one.name}" is claimed by ${(sourceOf.get(one.name) ?? []).join(" and ")}, so the name identifies neither.`,
		});
	}

	return { agents: read.filter((one) => !contested(one)), skipped };
}
