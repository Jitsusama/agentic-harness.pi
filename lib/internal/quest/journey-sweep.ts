/**
 * Keeps a README's Journey section down to its pointer. Every Journey
 * entry is written through here (`append-journey.ts`), which first
 * moves anything still in the README's section to the head of the
 * file, so the new entry lands above it: a scaffold's first entry, or
 * one a session still running older code appended. A quest is swept
 * once more as it is created. The one-shot migration moved every
 * README's whole Journey through the same planner. A Journey file left
 * at its former place, `attachments/journey.md`, is folded in here too.
 *
 * The section once also carried a comment line naming the attachments
 * only the Journey cited, because the backup counted only what the
 * README and ID documents cite. The backup and the record audit now
 * both read what `JOURNEY.md` cites, so a sweep drops that line.
 *
 * Nothing is dropped. Every line of the section but the pointer and
 * the former citations line moves, verbatim and in order, to the head of the file;
 * the file is written before the README, so a crash between the two
 * duplicates lines rather than losing them. Reference-style link
 * definitions go with the lines that use them: a definition the rest
 * of the README still uses stays there too, and one a moved line uses
 * but the README defines elsewhere is copied into the file.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, withQuestLock } from "./io.ts";
import {
	formerJourneyFilePath,
	isJourneyPointer,
	JOURNEY_POINTER,
	journeyBody,
	journeyFilePath,
	mergeJourneyBodies,
	readmeJourneySection,
	renderJourneyFile,
} from "./journey.ts";

/** How the former citations line opens, which is how a sweep drops it. */
export const CITATIONS_OPENING =
	"<!-- Cited from the Journey, kept here so the backup keeps them:";

const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s/;
// A full reference, `[text][label]`, and a shortcut or collapsed one,
// `[label]` or `[label][]`. Reading too many as uses only keeps or
// copies a definition that was not needed, which costs a line.
const FULL_REFERENCE = /\]\[([^\]]+)\]/g;
const SHORTCUT_REFERENCE = /\[([^\]]+)\](?![(:]|\[[^\]])/g;

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

	const tail = lines.slice(section.end);
	const replaced = [
		...lines.slice(0, section.start + 1),
		"",
		JOURNEY_POINTER,
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
	const plan = planJourneySweep(readme, { journey, prepend });
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
