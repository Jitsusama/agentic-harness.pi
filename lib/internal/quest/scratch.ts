/**
 * The quest's managed scratch directory: a reapable space the gate
 * funnels ad-hoc writes into. It is created on demand under the OS
 * temp dir, so it lands on whatever volume the system designates as
 * temp (honouring $TMPDIR) and carries a unique mkdtemp namespace
 * the kernel guarantees is fresh. The path is persisted on the
 * quest frontmatter so it survives across sessions and can be
 * reaped on conclude or retire.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseQuestFrontMatter,
	serializeQuestFrontMatter,
} from "./frontmatter.js";
import { withQuestLock } from "./io.js";

/** Path to a quest's README. */
function questReadme(questDir: string): string {
	return join(questDir, "README.md");
}

/**
 * Set or clear the quest's persisted scratchDir under the quest
 * lock. A read-modify-write on the README frontmatter, mirroring
 * the tree writers; the body is preserved verbatim.
 */
function persistScratchDir(questDir: string, value: string | undefined): void {
	const path = questReadme(questDir);
	if (!existsSync(path)) return;
	withQuestLock(questDir, () => {
		const text = readFileSync(path, "utf8");
		const parsed = parseQuestFrontMatter(text);
		if (!parsed) return;
		const fm = { ...parsed.frontMatter };
		if (value) fm.scratchDir = value;
		else delete fm.scratchDir;
		writeFileSync(path, `${serializeQuestFrontMatter(fm)}\n${parsed.body}`);
	});
}

/**
 * Return the quest's managed scratch directory, creating and
 * recording it on first need. When `current` already points at a
 * live directory it is reused; otherwise a fresh mkdtemp namespace
 * is created under the OS temp dir and persisted to the quest.
 */
export function ensureQuestScratchDir(
	questDir: string,
	questId: string,
	current: string | null,
): string {
	if (current && existsSync(current)) return current;
	const dir = mkdtempSync(join(tmpdir(), `pi-quest-${questId}-`));
	persistScratchDir(questDir, dir);
	return dir;
}

/**
 * Remove the quest's managed scratch directory and clear the
 * persisted path. Returns whether a directory was recorded to
 * reap. A removal failure is swallowed: reaping is best-effort
 * cleanup, never a reason to block conclude or retire.
 */
export function reapQuestScratchDir(
	questDir: string,
	current: string | null,
): boolean {
	if (current) {
		try {
			rmSync(current, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup: a wedged scratch dir must not stop the
			// quest from concluding. The cleared frontmatter still drops
			// the reference.
		}
	}
	persistScratchDir(questDir, undefined);
	return Boolean(current);
}
