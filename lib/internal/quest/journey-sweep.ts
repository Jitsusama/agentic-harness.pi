/**
 * Keeps a README's Journey section down to its pointer. Two jobs:
 *
 * - Sweep. Every Journey entry is written through here
 *   (`append-journey.ts`), which first moves anything still in the
 *   README's section to the head of the file, so the new entry lands
 *   above it: a scaffold's first entry, or one a session still running
 *   older code appended. A quest is swept once more as it is created.
 *   The one-shot migration moved every README's whole Journey through
 *   the same planner. A Journey file left at its former place,
 *   `attachments/journey.md`, is folded in here too.
 * - Carry citations. The backup counts only what the README and the
 *   ID documents cite, so an attachment cited only from the Journey
 *   would leave the backup. The README's section carries those
 *   citations in one comment line, folded to the widest folders it
 *   can name without citing anything new, until the backup reads
 *   `JOURNEY.md` as the record audit already does.
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
	rmdirSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { attachmentCitations } from "../../core/internal/quest/record.ts";
import { atomicWriteFile, withQuestLock } from "./io.ts";
import {
	formerJourneyFilePath,
	isJourneyPointer,
	JOURNEY_FILE,
	JOURNEY_POINTER,
	journeyBody,
	journeyFilePath,
	mergeJourneyBodies,
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
		isJourneyPointer(l) || l.startsWith(CITATIONS_OPENING);
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
 * its head, the caller holding the quest's lock. A Journey file still
 * at its former place is merged in by date, and removed once the file
 * beside the README is written. Returns how
 * many README lines moved, or undefined when the quest has no README.
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
	const formerPath = formerJourneyFilePath(questDir);
	const current = textAt(filePath);
	const former = textAt(formerPath);
	// A session still on older code writes the former file, so either
	// may hold the newest entries: the two are merged by date.
	const journey =
		former === undefined
			? current
			: renderJourneyFile(
					mergeJourneyBodies(
						current === undefined ? [] : journeyBody(current),
						journeyBody(former),
					),
				);
	const plan = planJourneySweep(readme, {
		journey,
		prepend,
		citations: {
			quest: basename(questDir),
			attachments: listAttachments(questDir),
		},
	});
	const next = plan?.journey ?? journey;
	// Written before anything is removed, so a crash between the two
	// leaves entries twice rather than losing them.
	if (next !== undefined && next !== current) {
		mkdirSync(dirname(filePath), { recursive: true });
		atomicWriteFile(filePath, next);
	}
	if (plan && plan.readme !== readme) atomicWriteFile(readmePath, plan.readme);
	if (former !== undefined) {
		rmSync(formerPath, { force: true });
		try {
			rmdirSync(dirname(formerPath));
		} catch {
			// attachments/ still holds other files, which is the common
			// case: only an emptied folder goes with the old Journey.
		}
	}
	return plan?.moved ?? 0;
}

function textAt(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Sweep a quest's README Journey into its file, under its lock. */
export function sweepJourney(questDir: string): number | undefined {
	if (!existsSync(join(questDir, "README.md"))) return undefined;
	return withQuestLock(questDir, () => sweepJourneyUnlocked(questDir));
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
