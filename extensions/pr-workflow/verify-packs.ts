/**
 * Per-stage verify-pack resolution.
 *
 * A "verify pack" is the (extension, skill) pair that
 * teaches and enforces one reviewer subagent's output
 * contract. The extension supplies the `verify_output`
 * tool; the skill teaches the subagent how to use it. Pi
 * loads the extension via `--extension <path>` and the
 * skill via `--skill <path>` when the reviewer dispatcher
 * spawns the subagent.
 *
 * One pack per stage so each reviewer only sees the
 * schema and contract prose relevant to its role. The
 * resolver computes absolute paths from `import.meta.url`:
 * jiti points it at the source location at load time, and
 * every pack lives at a known relative offset.
 *
 * The pack entry points live under
 * `lib/internal/pr-workflow-verify/packs/`, not under
 * `extensions/`, on purpose. Pi auto-discovers `.ts` files
 * directly under `extensions/`, and all five packs register
 * the same `verify_output` tool with different stage
 * schemas. Auto-discovery would either collide on tool name
 * or make the active verifier depend on load order. The
 * resolver injects the right pack into a reviewer subagent
 * via `--extension`; nothing else loads them.
 *
 * Throws if a pack's files aren't on disk — that points
 * at a packaging bug rather than a runtime miss, and
 * silently disabling self-verify in every reviewer would
 * be worse than crashing here.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Stage names that have a verify pack. Mirrors the union
 * elsewhere in pr-workflow; we restate it here so callers
 * passing arbitrary strings get a typed signal at the
 * resolver boundary.
 */
export type VerifyPackStage =
	| "council"
	| "judge"
	| "critique"
	| "stack-review"
	| "stack-judge";

/**
 * A verify pack: the absolute paths pi needs to inject
 * into a reviewer subagent so the subagent can call
 * `verify_output` and learn the contract that teaches it
 * to use the tool.
 *
 * `skillPath` is optional only to match the shape the
 * upcoming subagent library will export. For pr-workflow's
 * own packs it is always present.
 */
export interface VerifyPack {
	readonly extensionPath: string;
	readonly skillPath?: string;
}

/**
 * Resolve the verify pack for `stage`. Returns `undefined`
 * only when `stage` itself is `undefined` (caller is
 * explicitly opting out of verification). Throws for any
 * other unrecognized stage so a typo or stale enum can't
 * silently disable self-verify at the safety boundary.
 */
export function resolveVerifyPack(
	stage: string | undefined,
): VerifyPack | undefined {
	if (stage === undefined) return undefined;
	if (!isVerifyPackStage(stage)) {
		throw new Error(
			`Unknown pr-workflow verification stage "${stage}". ` +
				"Expected one of: council, judge, critique, stack-review, stack-judge.",
		);
	}
	const extensionRelPath = `../../lib/internal/pr-workflow-verify/packs/${stage}.ts`;
	const skillRelPath = `../../skills/pr-workflow-${stage}-output/SKILL.md`;
	const extensionPath = absolute(extensionRelPath);
	const skillPath = absolute(skillRelPath);
	assertExists(extensionPath, `pr-workflow-${stage}-verify`);
	assertExists(skillPath, `pr-workflow-${stage}-output skill`);
	return { extensionPath, skillPath };
}

function isVerifyPackStage(
	value: string | undefined,
): value is VerifyPackStage {
	return (
		value === "council" ||
		value === "judge" ||
		value === "critique" ||
		value === "stack-review" ||
		value === "stack-judge"
	);
}

function absolute(relPath: string): string {
	return fileURLToPath(new URL(relPath, import.meta.url));
}

function assertExists(path: string, label: string): void {
	if (existsSync(path)) return;
	throw new Error(
		`${label} not found at ${path}. The pack must be co-located with ` +
			"pr-workflow for reviewer self-verify to work.",
	);
}
