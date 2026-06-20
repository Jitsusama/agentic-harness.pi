/**
 * The quest's managed scratch directory: a reapable space the gate
 * funnels ad-hoc writes into. It is created on demand under the OS
 * temp dir, so it lands on whatever volume the system designates as
 * temp (honouring $TMPDIR) and carries a unique mkdtemp namespace
 * the kernel guarantees is fresh. The path is persisted on the
 * quest frontmatter so it survives across sessions and can be
 * reaped on conclude or retire.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { QuestFrontMatter } from "../../quest/types.js";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "./frontmatter.js";
import { isWithin } from "./git-signals.js";
import { atomicWriteFile, withQuestLock } from "./io.js";

/** The basename prefix every managed scratch dir carries. */
const SCRATCH_PREFIX = "pi-quest-";

/** Path to a quest's README. */
function questReadme(questDir: string): string {
	return join(questDir, "README.md");
}

/**
 * Write the quest's scratchDir into already-parsed frontmatter,
 * preserving the body, using the atomic torn-read-safe write the
 * other quest writers use. The caller holds the quest lock.
 */
function writeScratchDir(
	path: string,
	parsed: { frontMatter: QuestFrontMatter; body: string },
	value: string | undefined,
): void {
	const fm = { ...parsed.frontMatter };
	if (value) fm.scratchDir = value;
	else delete fm.scratchDir;
	atomicWriteFile(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
}

/**
 * Whether a recorded path is safe to recursively delete: it must sit
 * under the OS temp dir and carry the managed-scratch prefix. A
 * stale, hand-edited or symlinked frontmatter value that fails this
 * is left untouched, so the reap can never rm -rf an arbitrary path.
 */
function isReapableScratch(dir: string): boolean {
	return isWithin(dir, tmpdir()) && basename(dir).startsWith(SCRATCH_PREFIX);
}

/**
 * Return the quest's managed scratch directory, creating and
 * recording it on first need. The whole check-create-persist runs
 * under one quest lock with the frontmatter as the source of truth:
 * a racing session that recorded a dir first wins, and we reuse it
 * rather than stranding a second mkdtemp. The frontmatter is read
 * and parsed before any directory is created, so a malformed README
 * fails loud instead of orphaning an unrecorded dir.
 */
export function ensureQuestScratchDir(
	questDir: string,
	questId: string,
	current: string | null,
): string {
	if (current && existsSync(current)) return current;
	return withQuestLock(questDir, () => {
		const path = questReadme(questDir);
		const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
		if (!parsed) {
			throw new Error(`Quest README at ${path} has no parseable front matter.`);
		}
		const recorded = parsed.frontMatter.scratchDir;
		if (recorded && existsSync(recorded)) return recorded;
		const dir = mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}${questId}-`));
		writeScratchDir(path, parsed, dir);
		return dir;
	});
}

/**
 * Remove the quest's managed scratch directory and clear the
 * persisted path. Returns whether a directory was recorded to reap.
 * The delete is contained to a real managed-scratch path and is
 * best-effort: a wedged or failed removal must not block conclude or
 * retire. The frontmatter reference is always cleared.
 */
export function reapQuestScratchDir(
	questDir: string,
	current: string | null,
): boolean {
	if (current && isReapableScratch(current)) {
		try {
			rmSync(current, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup: a wedged scratch dir must not stop the
			// quest from concluding. The cleared frontmatter still drops
			// the reference.
		}
	}
	const path = questReadme(questDir);
	if (existsSync(path)) {
		withQuestLock(questDir, () => {
			const parsed = parseQuestFrontMatter(readFileSync(path, "utf8"));
			if (parsed) writeScratchDir(path, parsed, undefined);
		});
	}
	return Boolean(current);
}
