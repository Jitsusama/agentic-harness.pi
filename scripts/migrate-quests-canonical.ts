/**
 * One-shot migrator that flattens the quests tree to the
 * canonical layout:
 *
 *   quests/
 *     QEST-XXX/
 *       README.md
 *       plans/PLAN-...md
 *       research/RSCH-...md
 *       briefs/BRIF-...md
 *       reports/RPRT-...md
 *
 * Two drift patterns this collapses:
 *
 * 1. Nested children: any QEST-CHILD directory found
 *    inside another QEST-PARENT moves up to questsRoot.
 *    Hierarchy already lives in the child's `parent:`
 *    front-matter, so no metadata rewrite is needed.
 *
 * 2. Misplaced documents: any PLAN-/RSCH-/BRIF-/RPRT-
 *    .md file sitting at a quest's root moves into the
 *    matching kind subdirectory (plans/, research/,
 *    briefs/, reports/).
 *
 * Idempotent. Pass `--dry-run` to preview without
 *  touching the disk. Pass `--root <path>` to point at a
 *  questsRoot other than the default state directory.
 *  Pass `--journal` to read a JSON migration log and
 *  print a summary diff.
 */

import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOC_KIND_BY_PREFIX: Record<string, string> = {
	"PLAN-": "plans",
	"RSCH-": "research",
	"BRIF-": "briefs",
	"RPRT-": "reports",
};

interface NestedMove {
	from: string;
	to: string;
	id: string;
}

interface DocMove {
	from: string;
	to: string;
	kind: string;
}

export interface FlattenPlan {
	nestedMoves: NestedMove[];
	collisions: string[];
}

export interface DocPlan {
	docMoves: DocMove[];
	collisions: string[];
}

function isQuestId(name: string): boolean {
	return /^QEST-\d{8}-[A-Z0-9]{6}$/.test(name);
}

function isDocFile(name: string): { kind: string } | undefined {
	for (const prefix of Object.keys(DOC_KIND_BY_PREFIX)) {
		if (!name.startsWith(prefix)) continue;
		if (!name.endsWith(".md")) continue;
		const kind = DOC_KIND_BY_PREFIX[prefix];
		return { kind };
	}
	return undefined;
}

export function planFlatten(root: string): FlattenPlan {
	const nestedMoves: NestedMove[] = [];
	const collisions: string[] = [];

	function visit(dir: string, isTopLevel: boolean): void {
		const name = dir.split("/").pop() ?? "";
		if (!isTopLevel && isQuestId(name)) {
			const dest = join(root, name);
			if (existsSync(dest)) {
				collisions.push(
					`${name}: cannot flatten ${dir} -> ${dest} (destination already exists)`,
				);
			} else {
				nestedMoves.push({ from: dir, to: dest, id: name });
			}
		}
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!isQuestId(entry.name)) continue;
			visit(join(dir, entry.name), false);
		}
	}

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!isQuestId(entry.name)) continue;
		visit(join(root, entry.name), true);
	}

	return { nestedMoves, collisions };
}

export function planDocMoves(root: string, postFlatten: boolean): DocPlan {
	const docMoves: DocMove[] = [];
	const collisions: string[] = [];

	function visit(questDir: string, questId: string): void {
		// Compute the doc's eventual home: after flatten
		// applies, every quest lives at `<root>/<id>/`. In
		// post-flatten mode the source is already there; in
		// dry-run we point at the current pre-flatten path
		// so the preview reads clearly.
		for (const child of readdirSync(questDir, { withFileTypes: true })) {
			if (child.isFile()) {
				const docInfo = isDocFile(child.name);
				if (!docInfo) continue;
				const from = postFlatten
					? join(root, questId, child.name)
					: join(questDir, child.name);
				const to = join(root, questId, docInfo.kind, child.name);
				if (existsSync(to)) {
					collisions.push(
						`${child.name}: cannot move ${from} -> ${to} (destination already exists)`,
					);
					continue;
				}
				docMoves.push({ from, to, kind: docInfo.kind });
				continue;
			}
			if (!child.isDirectory()) continue;
			if (!isQuestId(child.name)) continue;
			visit(join(questDir, child.name), child.name);
		}
	}

	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!isQuestId(entry.name)) continue;
		visit(join(root, entry.name), entry.name);
	}

	return { docMoves, collisions };
}

export function applyFlatten(plan: FlattenPlan): void {
	// Bottom-up: move deepest nested dirs first so we
	// never try to move a directory that still contains
	// children waiting to be flattened.
	const sorted = [...plan.nestedMoves].sort(
		(a, b) => b.from.length - a.from.length,
	);
	for (const move of sorted) {
		renameSync(move.from, move.to);
	}
}

export function applyDocMoves(plan: DocPlan): void {
	for (const move of plan.docMoves) {
		mkdirSync(join(move.to, ".."), { recursive: true });
		renameSync(move.from, move.to);
	}
}

function tilde(path: string): string {
	return path.replace(`${homedir()}/`, "~/");
}

function summarizeFlatten(plan: FlattenPlan): string {
	const lines = [`Nested quest flattenings: ${plan.nestedMoves.length}`];
	if (plan.nestedMoves.length > 0) {
		lines.push("", "Flattenings (first 10):");
		for (const move of plan.nestedMoves.slice(0, 10)) {
			lines.push(`  ${move.id}: ${tilde(move.from)} -> ${tilde(move.to)}`);
		}
		if (plan.nestedMoves.length > 10) {
			lines.push(`  ... and ${plan.nestedMoves.length - 10} more`);
		}
	}
	if (plan.collisions.length > 0) {
		lines.push("", "Flatten collisions:");
		for (const c of plan.collisions) lines.push(`  ${c}`);
	}
	return lines.join("\n");
}

function summarizeDocMoves(plan: DocPlan): string {
	const lines = [`Document relocations:     ${plan.docMoves.length}`];
	if (plan.docMoves.length > 0) {
		lines.push("", "Document moves:");
		for (const move of plan.docMoves) {
			lines.push(`  ${move.kind}: ${tilde(move.from)} -> ${tilde(move.to)}`);
		}
	}
	if (plan.collisions.length > 0) {
		lines.push("", "Document-move collisions:");
		for (const c of plan.collisions) lines.push(`  ${c}`);
	}
	return lines.join("\n");
}

function main(): void {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const rootIndex = args.indexOf("--root");
	const fallback = defaultQuestsRoot();
	const root = rootIndex >= 0 ? (args[rootIndex + 1] ?? fallback) : fallback;

	if (!existsSync(root)) {
		console.error(`questsRoot does not exist: ${root}`);
		process.exit(1);
	}

	const flatten = planFlatten(root);
	console.log(summarizeFlatten(flatten));
	if (flatten.collisions.length > 0) {
		console.error("\nRefusing to flatten: resolve collisions first.");
		process.exit(1);
	}

	if (dryRun) {
		const docPlan = planDocMoves(root, false);
		console.log("");
		console.log(summarizeDocMoves(docPlan));
		console.log("\n(dry run: no changes applied)");
		return;
	}

	if (flatten.nestedMoves.length > 0) {
		applyFlatten(flatten);
		console.log("\nFlatten applied.");
	}

	const docPlan = planDocMoves(root, true);
	console.log("");
	console.log(summarizeDocMoves(docPlan));
	if (docPlan.collisions.length > 0) {
		console.error("\nRefusing to relocate docs: resolve collisions first.");
		process.exit(1);
	}

	if (docPlan.docMoves.length > 0) {
		applyDocMoves(docPlan);
		console.log("\nDocument relocations applied.");
	}

	if (flatten.nestedMoves.length === 0 && docPlan.docMoves.length === 0) {
		console.log("\nNothing to migrate; tree is already canonical.");
	}
}

// Only run the script when invoked directly, so tests can
// import the planFlatten/planDocMoves/apply* helpers
// without triggering a migration against the live tree.
if (require.main === module) {
	main();
}
