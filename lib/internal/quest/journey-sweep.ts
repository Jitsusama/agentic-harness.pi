/**
 * TEMPORARY: the core fold deletes this file.
 *
 * Keeps a README's Journey section down to its pointer while core and
 * the backup still expect the Journey in the README. Two jobs, both
 * gone at the fold:
 *
 * - Sweep. Core 0.16.2's own verbs (alias, reorder, reparent, undo,
 *   bulk conclude and retire) still append their entries to the
 *   README. The quest tool sweeps the quests an action touched once it
 *   has run, and the harness's own Journey writer sweeps as it writes,
 *   so the order holds: what core appended is newer than the file's
 *   head. The one-shot migration moves every README's whole Journey
 *   through the same planner.
 * - Carry citations. The record audit and the backup count only what
 *   the README and the ID documents cite, so an attachment cited only
 *   from the Journey would read as uncited and leave the backup. The
 *   README's section carries those citations in one comment line,
 *   folded to the widest folders it can name without citing anything
 *   new. At the fold the backup reads JOURNEY.md itself.
 *
 * Nothing is dropped. Every line of the section but the pointer and
 * the citations moves, verbatim and in order, to the head of the file;
 * the file is written before the README, so a crash between the two
 * duplicates lines rather than losing them. Reference-style link
 * definitions go with the lines that use them: a definition the rest
 * of the README still uses stays there too, and one a moved line uses
 * but the README defines elsewhere is copied into the file.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { attachmentCitations } from "@jitsusama/agentic-harness.core/quest/record";
import { atomicWriteFile, withQuestLock } from "./io.ts";
import {
	JOURNEY_FILE,
	JOURNEY_POINTER,
	journeyBody,
	journeyFilePath,
	readmeJourneySection,
	renderJourneyFile,
} from "./journey.ts";

/** How the citations line opens, which is how a sweep finds it. */
export const CITATIONS_OPENING =
	"<!-- Cited from the Journey, kept here so the backup keeps them:";

const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s/;
// A full reference, `[text][label]`, and a shortcut or collapsed one,
// `[label]` or `[label][]`. Reading too many as uses only keeps or
// copies a definition that was not needed, which costs a line.
const FULL_REFERENCE = /\]\[([^\]]+)\]/g;
const SHORTCUT_REFERENCE = /\[([^\]]+)\](?![(:]|\[[^\]])/g;
// What ends a bare mention for the citation scan, so a path holding
// one is written as a link instead.
const MENTION_BREAK = /[\s`'"()<>[\]|,;]/;
// Files the backup skips: the quest lock, macOS litter, atomic-write
// temporaries.
const MACHINERY = /^(\.quest\.lock|\.DS_Store|\..+\.tmp-\d+-.*)$/;

/** What a sweep would write, or undefined when it has nothing to do. */
export interface SweepPlan {
	readme: string;
	journey: string;
	/** Lines moved out of the README, the pointer and blanks excluded. */
	moved: number;
}

/** What a sweep is planned from, beside the README's own text. */
export interface SweepInput {
	/** The Journey file's text, undefined when there is none yet. */
	journey?: string;
	/** New entries to put at the very head of the Journey. */
	prepend?: readonly string[];
	/**
	 * The quest's id and its attachments, quest-relative, for the
	 * citations line. Left out, the line is kept as it stands.
	 */
	citations?: { quest: string; attachments: readonly string[] };
}

/**
 * Plan a sweep: the README and Journey file it would write. Pure, so
 * the migration can count before it writes.
 */
export function planJourneySweep(
	readme: string,
	input: SweepInput = {},
): SweepPlan | undefined {
	const prepared = readmeJourneySection(readme)
		? readme
		: `${readme.replace(/\n*$/, "\n")}\n## 🌄 Journey\n`;
	const section = readmeJourneySection(prepared);
	if (!section) return undefined;
	const lines = prepared.split("\n");
	const outside = [
		...lines.slice(0, section.start),
		...lines.slice(section.end),
	];
	const isMachinery = (l: string) =>
		l.trim() === JOURNEY_POINTER || l.startsWith(CITATIONS_OPENING);
	const moving = section.lines.filter((l) => !isMachinery(l));
	const movingDefinitions = moving.filter((l) => DEFINITION.test(l));
	const movingContent = trimBlank(moving.filter((l) => !DEFINITION.test(l)));

	const fileBody =
		input.journey === undefined ? [] : journeyBody(input.journey);
	const usedOutside = labelsUsed(outside);
	const kept = movingDefinitions.filter((l) => usedOutside.has(labelOf(l)));
	const fileLabels = new Set(
		fileBody.filter((l) => DEFINITION.test(l)).map(labelOf),
	);
	const movedLabels = new Set(movingDefinitions.map(labelOf));
	const usedMoving = labelsUsed([...(input.prepend ?? []), ...movingContent]);
	const borrowed = outside.filter((l) => {
		if (!DEFINITION.test(l)) return false;
		const label = labelOf(l);
		return usedMoving.has(label) && !movedLabels.has(label);
	});
	const newDefinitions = [...movingDefinitions, ...borrowed].filter(
		(l) => !fileLabels.has(labelOf(l)),
	);
	const body = [...(input.prepend ?? []), ...movingContent, ...fileBody];
	if (newDefinitions.length > 0) {
		if (body.length > 0) body.push("");
		body.push(...newDefinitions);
	}
	const journey = renderJourneyFile(body);

	const citations = input.citations
		? citationsLine(
				input.citations.quest,
				journey,
				[...outside, ...kept].join("\n"),
				input.citations.attachments,
			)
		: section.lines.find((l) => l.startsWith(CITATIONS_OPENING));
	const tail = lines.slice(section.end);
	const replaced = [
		...lines.slice(0, section.start + 1),
		"",
		JOURNEY_POINTER,
		...(citations ? ["", citations] : []),
		...(kept.length > 0 ? ["", ...kept] : []),
		...(tail.length > 0 ? ["", ...tail] : [""]),
	];
	const newReadme = replaced.join("\n").replace(/\n*$/, "\n");
	if (input.journey === journey && newReadme === readme) return undefined;
	return {
		readme: newReadme,
		journey,
		moved: [...movingContent, ...movingDefinitions].filter(
			(l) => l.trim() !== "",
		).length,
	};
}

/**
 * The comment line naming the attachments only the Journey cites, or
 * undefined when the README already cites all it does. Each run of
 * them is folded to the widest folder whose every attachment is cited
 * already, so the line cites nothing the Journey and README did not.
 */
export function citationsLine(
	quest: string,
	journey: string,
	restOfReadme: string,
	attachments: readonly string[],
): string | undefined {
	const citedBy = (rel: string, text: string) =>
		new Set(
			attachmentCitations(
				quest,
				[{ rel, text }],
				[...attachments],
			).cited.keys(),
		);
	const fromReadme = citedBy("README.md", restOfReadme);
	const need = [...citedBy(JOURNEY_FILE, journey)].filter(
		(a) => a !== JOURNEY_FILE && !fromReadme.has(a),
	);
	if (need.length === 0) return undefined;
	const allowed = new Set([...need, ...fromReadme, JOURNEY_FILE]);
	const named = new Set<string>();
	for (const path of need.sort()) {
		const segments = path.split("/");
		let chosen = path;
		// Folders below attachments/ itself, widest first.
		for (let depth = 2; depth < segments.length; depth++) {
			const folder = segments.slice(0, depth).join("/");
			const under = attachments.filter((a) => a.startsWith(`${folder}/`));
			if (under.every((a) => allowed.has(a))) {
				chosen = folder;
				break;
			}
		}
		named.add(chosen);
	}
	const written = [...named]
		.sort()
		.map((p) => (MENTION_BREAK.test(p) ? `[](<${p}>)` : p));
	return `${CITATIONS_OPENING} ${written.join(" ")} -->`;
}

/**
 * Every attachment under a quest, quest-relative, as the backup lists
 * them: machinery skipped, and a symlink or checkout listed rather
 * than entered.
 */
export function listAttachments(questDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, rel: string) => {
		for (const name of readdirSync(dir).sort()) {
			if (MACHINERY.test(name)) continue;
			const path = join(dir, name);
			const relPath = `${rel}/${name}`;
			const stats = lstatSync(path);
			if (stats.isDirectory() && name !== ".git") walk(path, relPath);
			else found.push(relPath);
		}
	};
	const top = join(questDir, "attachments");
	if (existsSync(top) && lstatSync(top).isDirectory()) walk(top, "attachments");
	return found;
}

/**
 * Sweep a quest's README Journey into its file, putting `prepend` at
 * its head, the caller holding the quest's lock. Returns how many
 * lines moved, or undefined when the quest has no README.
 */
export function sweepJourneyUnlocked(
	questDir: string,
	prepend: readonly string[] = [],
): number | undefined {
	const readmePath = join(questDir, "README.md");
	let readme: string;
	try {
		readme = readFileSync(readmePath, "utf8");
	} catch {
		// No README, no quest: nothing to sweep, and the caller says so.
		return undefined;
	}
	const filePath = journeyFilePath(questDir);
	const journey = existsSync(filePath)
		? readFileSync(filePath, "utf8")
		: undefined;
	const plan = planJourneySweep(readme, {
		journey,
		prepend,
		citations: {
			quest: basename(questDir),
			attachments: listAttachments(questDir),
		},
	});
	if (!plan) return 0;
	if (plan.journey !== journey) {
		mkdirSync(dirname(filePath), { recursive: true });
		atomicWriteFile(filePath, plan.journey);
	}
	if (plan.readme !== readme) atomicWriteFile(readmePath, plan.readme);
	return plan.moved;
}

/** Sweep a quest's README Journey into its file, under its lock. */
export function sweepJourney(questDir: string): number | undefined {
	if (!existsSync(join(questDir, "README.md"))) return undefined;
	return withQuestLock(questDir, () => sweepJourneyUnlocked(questDir));
}

/**
 * The quest-tool actions that run one of core's verbs, which append
 * to a README's Journey: alias-add and alias-remove, the rank and
 * priority verbs, reparent, undo, and conclude and retire of quests
 * other than the loaded one.
 */
const CORE_JOURNALING_ACTIONS: ReadonlySet<string> = new Set([
	"alias-add",
	"alias-remove",
	"top",
	"bottom",
	"bump",
	"sink",
	"before",
	"after",
	"renumber",
	"promote",
	"demote",
	"drive",
	"park",
	"defer",
	"reparent",
	"undo",
	"conclude",
	"retire",
]);

/**
 * Sweep the quests a quest-tool action may have had core append to:
 * the loaded quest and each quest the action named by id. Any other
 * action, and a quest the resolver cannot find, is skipped, since
 * core wrote nothing there.
 */
export function sweepAfterQuestAction(
	action: string,
	loadedDir: string | null | undefined,
	ids: readonly string[],
	resolve: (id: string) => string | undefined,
): void {
	if (!CORE_JOURNALING_ACTIONS.has(action)) return;
	const dirs = new Set<string>();
	if (loadedDir) dirs.add(loadedDir);
	for (const id of ids) {
		const dir = resolve(id);
		if (dir) dirs.add(dir);
	}
	for (const dir of dirs) {
		try {
			sweepJourney(dir);
		} catch (error) {
			// A sweep that fails leaves the entries in the README, where
			// every reader still finds them; the next sweep moves them.
			console.warn(`[quest] Journey sweep failed in ${dir}: ${error}`);
		}
	}
}

function labelOf(line: string): string {
	return (DEFINITION.exec(line)?.[1] ?? "").toLowerCase();
}

function labelsUsed(lines: readonly string[]): Set<string> {
	const labels = new Set<string>();
	for (const line of lines) {
		if (DEFINITION.test(line)) continue;
		for (const m of line.matchAll(FULL_REFERENCE))
			labels.add(m[1].toLowerCase());
		for (const m of line.matchAll(SHORTCUT_REFERENCE))
			labels.add(m[1].toLowerCase());
	}
	return labels;
}

function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
