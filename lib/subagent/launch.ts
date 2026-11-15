/**
 * How a reviewer's pi is started.
 *
 * The argv a run is handed, the extensions and skills it loads, the
 * tools it may call, and the brief file it reads its prompt from. These
 * change when pi's flags or the way a round shares its brief does, and
 * every run, resume and wrap-up composes its process here.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSubagentDefaults } from "./defaults.ts";
import type {
	RunReviewerOptions,
	StartReviewerOptions,
	SubagentSpec,
} from "./run-contract.ts";
// biome-ignore lint/correctness/useImportExtensions: Biome reads the .d.mts beside this .mjs as the module and asks for .mjs.mts, a file that doesn't exist.
import { JOURNAL_TOOL_NAME } from "./runpi/journal.mjs";

/**
 * Tool name a verify pack registers. A subagent calls it to
 * validate its JSON output before ending the run, when the
 * caller attached a pack; the `subagent` tool's `verify`
 * option is what does so. Pi's `--tools`
 * flag is an allowlist that applies to extension tools too,
 * so the dispatcher must include this in any non-empty
 * allowlist or the reviewer would be denied access to a
 * tool the prompt instructs it to use.
 */
export const VERIFY_TOOL_NAME = "verify_output";

function dedupePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

interface ComposeArgsInput {
	readonly spec: SubagentSpec;
	readonly prompt: string;
	/** A second positional after the prompt, which pi appends to it. */
	readonly ask?: string;
	readonly systemPrompt?: string;
	readonly isolated?: boolean;
	readonly extraExtensions?: readonly string[];
	readonly extraSkills?: readonly string[];
	/**
	 * When set, reopen this session file (--session) and
	 * continue it instead of starting a fresh ephemeral run
	 * (--no-session). Used by the auto-resume path.
	 */
	readonly resumeSessionPath?: string;
}

/**
 * The pack that marks where a shared brief ends, so a round's
 * reviewers can read the brief from the cache the first one wrote.
 */
const SHARED_BRIEF_PACK = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"packs",
	"shared-brief",
	"index.ts",
);

/**
 * The extensions and skills a reviewer loads: the engine-wide
 * defaults, the caller's own, and, for a reviewer with an ask of its
 * own, the pack that lets it share the brief before it.
 *
 * Defaults first and deduplicated, so a path registered as a default
 * and passed again by a caller loads once.
 */
export function reviewerLoadout(options: RunReviewerOptions | StartReviewerOptions): {
	extraExtensions: string[];
	extraSkills: string[];
} {
	const defaults = getSubagentDefaults();
	return {
		extraExtensions: dedupePaths([
			...defaults.extensions,
			...(options.extraExtensions ?? []),
			...(options.ask === undefined ? [] : [SHARED_BRIEF_PACK]),
		]),
		extraSkills: dedupePaths([
			...defaults.skills,
			...(options.extraSkills ?? []),
		]),
	};
}

/**
 * A brief's file name, from its content.
 *
 * Pi puts the path at the very head of the message, so a name drawn
 * at random gave every reviewer of a round a different first line and
 * nothing after it could be shared. Named by content, reviewers sent
 * the same brief open with the same bytes.
 */
export function briefName(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

/**
 * Write a file so no reader ever sees part of it.
 *
 * Reviewers share one brief, and the second may write it while the
 * first one's child is reading it. Written beside and renamed into
 * place, a reader has the old whole file or the new one, which are the
 * same text.
 */
export async function writeWhole(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const beside = `${path}.${randomUUID()}.part`;
	await writeFile(beside, text, "utf-8");
	await rename(beside, path);
}

/** Everything a reviewer was asked, as the record of its question. */
export function wholeQuestion(options: RunReviewerOptions | StartReviewerOptions) {
	return options.ask === undefined
		? options.prompt
		: `${options.prompt}\n\n${options.ask}`;
}

/**
 * How many waiting runs hold each brief file this process wrote.
 *
 * Several reviewers read one brief, and the first to finish must not
 * take it from one that has not started: a round starts its first
 * reviewer and the rest a little later, and the first can fail fast.
 */
const briefHolders = new Map<
	string,
	{ holders: number; written: Promise<void> }
>();

/**
 * What tells this copy's briefs from another's in the same process. A
 * host's conversations share this copy and its holders, one count
 * covering them all, so conversations sending the same brief share one
 * file of the same bytes, removed at the last release. A copy a reload
 * makes, or one a package loads per folder, counts only its own
 * holders. Two copies sending one brief must never name the same file.
 */
const BRIEF_COPY = randomBytes(4).toString("hex");

/**
 * Write a brief to a temp file named by its content, and hold it until
 * released; the last release removes it.
 *
 * Named for this process and this copy of the module as well as the
 * content, so another session or conversation sending the same brief
 * at the same moment can never remove the file from under this one.
 * The `.md` extension makes pi read the file as prompt text.
 */
export async function holdBrief(
	prompt: string,
): Promise<{ path: string; release: () => Promise<void> }> {
	const path = join(
		tmpdir(),
		`pi-reviewer-prompt-${process.pid}-${BRIEF_COPY}-${briefName(prompt)}.md`,
	);
	// The write is shared as well as the file: a second holder arriving
	// while the first is still writing waits for that write rather than
	// handing its child a path with nothing at it yet.
	const held = briefHolders.get(path) ?? {
		holders: 0,
		written: writeWhole(path, prompt),
	};
	held.holders += 1;
	briefHolders.set(path, held);
	try {
		await held.written;
	} catch (error) {
		await releaseBrief(path);
		throw error;
	}
	return { path, release: () => releaseBrief(path) };
}

async function releaseBrief(path: string): Promise<void> {
	const held = briefHolders.get(path);
	if (held === undefined) return;
	held.holders -= 1;
	if (held.holders > 0) return;
	briefHolders.delete(path);
	// Best-effort: the OS temp dir is reaped anyway, and a failed
	// unlink must not mask the run's own outcome.
	await rm(path, { force: true }).catch(() => {});
}

export function composeArgs(input: ComposeArgsInput): string[] {
	const args: string[] = [
		"--mode",
		"json",
		...(input.resumeSessionPath
			? ["--session", input.resumeSessionPath]
			: ["--no-session"]),
		"-p",
	];
	if (input.spec.model) {
		args.push("--model", input.spec.model);
	}
	if (input.spec.thinkingLevel) {
		args.push("--thinking", input.spec.thinkingLevel);
	}
	if (input.spec.tools && input.spec.tools.length > 0) {
		args.push("--tools", buildToolsAllowlist(input.spec.tools));
	}
	if (input.systemPrompt) {
		args.push("--system-prompt", input.systemPrompt);
	}
	if (input.isolated) {
		// Pi's flags together strip every form of ambient
		// inheritance: package- and user-scoped skills,
		// AGENTS.md context files, auto-discovered
		// extensions, and the project-local resources that
		// project trust gates. Callers that pass
		// extraExtensions or extraSkills get those layered
		// back on top by the flags below; nothing else
		// loads.
		//
		// The fourth flag is the one that was missing, and
		// it was measured rather than reasoned about. A
		// `.pi/SYSTEM.md` in the working directory replaces
		// the system prompt outright, and project trust is
		// what decides whether it is read. Non-interactive
		// runs ignore it by default, so the first three
		// flags looked sufficient; on a machine whose
		// operator has trusted the project, or set
		// defaultProjectTrust to always, the same three
		// flags let a file in the tree turn a reviewer into
		// a fruit naming service. Asked what two plus two
		// is, it answered KUMQUAT.
		//
		// Isolation that depends on the reader's settings
		// is not isolation, and this is a subagent reading
		// a tree somebody else wrote.
		args.push(
			"--no-skills",
			"--no-context-files",
			"--no-extensions",
			"--no-approve",
		);
	}
	if (input.extraExtensions) {
		for (const path of input.extraExtensions) {
			args.push("--extension", path);
		}
	}
	if (input.extraSkills) {
		for (const path of input.extraSkills) {
			args.push("--skill", path);
		}
	}
	args.push(input.prompt);
	if (input.ask !== undefined) args.push(input.ask);
	return args;
}

/**
 * Build the comma-separated value for pi's `--tools` flag
 * from a reviewer's configured palette. The verify tool is
 * appended (deduplicated, preserving order) so the
 * reviewer can always self-validate even when the user
 * restricts the palette.
 */
function buildToolsAllowlist(palette: readonly string[]): string {
	const tools: string[] = [];
	for (const tool of palette) {
		if (!tools.includes(tool)) {
			tools.push(tool);
		}
	}
	for (const always of [VERIFY_TOOL_NAME, JOURNAL_TOOL_NAME]) {
		if (!tools.includes(always)) tools.push(always);
	}
	return tools.join(",");
}
