/**
 * A quest's documents on disk: the focused document's stage, sealing
 * the ones still open when the quest ends, and scaffolding a new one.
 * Each write is validated by parsing it back, so no document is ever
 * left in a shape the strict reader drops from discovery.
 */

import { type Dirent, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nowYmd } from "../../internal/quest/dates.ts";
import { explainDocumentFrontMatter } from "../../internal/quest/frontmatter.ts";
import {
	atomicWriteFile,
	atomicWriteUnderLock,
	withQuestLock,
} from "../../internal/quest/io.ts";
import {
	type DocumentFrontMatter,
	type DocumentKind,
	type DocumentStage,
	parseDocumentFrontMatter,
	serializeDocumentFrontMatter,
} from "../../quest/index.ts";
import type { Stage } from "./machine.ts";
import type { QuestState } from "./state.ts";

/**
 * Persist the focused document's stage to its file and mirror it in
 * state. Returns true when the stage reached disk, false when there
 * is nothing to write to or the file is unreadable or unparseable,
 * so the caller can refuse rather than let memory run ahead of disk.
 */
export function writeDocumentStage(state: QuestState, stage: Stage): boolean {
	const documentPath = state.documentPath;
	if (!documentPath) return false;
	const questDir = state.questDir;
	// Read and write under one lock, so another quest write cannot land
	// between them and be overwritten with the body read before it.
	const rewrite = (): boolean => {
		let text: string;
		try {
			text = readFileSync(documentPath, "utf8");
		} catch {
			return false;
		}
		const parsed = parseDocumentFrontMatter(text);
		if (!parsed) return false;
		const newFm: DocumentFrontMatter = {
			...parsed.frontMatter,
			stage: stage as DocumentStage,
			updated: nowYmd(),
		};
		const newText = `${serializeDocumentFrontMatter(newFm)}\n${parsed.body}`;
		// Validate by parse-back, matching the quest mutation core: never
		// write a document the strict parser cannot read back, which would
		// drop it to an out-of-vocabulary stage and make it invisible.
		const reparsed = parseDocumentFrontMatter(newText);
		if (!reparsed || reparsed.frontMatter.stage !== newFm.stage) return false;
		atomicWriteFile(documentPath, newText);
		return true;
	};
	const written = questDir ? withQuestLock(questDir, rewrite) : rewrite();
	if (written) state.documentStage = stage;
	return written;
}

const DOC_KIND_DIRS = ["plans", "research", "briefs", "reports"];
const ACTIVE_DOC_STAGES = new Set(["think", "draft", "build"]);

/**
 * Seal every still-active document under a quest to the quest's
 * terminal stage, so concluding or retiring a quest does not leave
 * documents stranded mid-stage. Returns how many were sealed.
 * Best-effort per file: an unreadable document is skipped, not fatal.
 */
export function sealQuestDocuments(
	questDir: string,
	target: "concluded" | "retired",
): number {
	let sealed = 0;
	for (const kindDir of DOC_KIND_DIRS) {
		const dir = join(questDir, kindDir);
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const docPath = join(dir, entry.name);
			let text: string;
			try {
				text = readFileSync(docPath, "utf8");
			} catch {
				continue;
			}
			const parsed = parseDocumentFrontMatter(text);
			if (!parsed) continue;
			if (!ACTIVE_DOC_STAGES.has(parsed.frontMatter.stage)) continue;
			const newFm: DocumentFrontMatter = {
				...parsed.frontMatter,
				stage: target,
				updated: nowYmd(),
			};
			const sealedText = `${serializeDocumentFrontMatter(newFm)}\n${parsed.body}`;
			// Validate by parse-back before writing, so the seal can never
			// produce a document the strict parser drops to invisible.
			const reparsed = parseDocumentFrontMatter(sealedText);
			if (!reparsed || reparsed.frontMatter.stage !== target) continue;
			atomicWriteUnderLock(questDir, docPath, sealedText);
			sealed++;
		}
	}
	return sealed;
}

/** Create a new document under the loaded quest. */
export function createDocument(
	state: QuestState,
	opts: {
		id: string;
		kind: DocumentKind;
		title: string;
		stage: Stage;
		scaffoldBody: string;
	},
): string | undefined {
	if (!state.questDir) return undefined;
	const subDir: Record<DocumentKind, string> = {
		plan: "plans",
		research: "research",
		brief: "briefs",
		report: "reports",
	};
	// Born readable or not born at all, the same rule the quest README
	// writers meet. This is the writer that produced the five documents
	// found invisible to discovery, and repairing the reader to fail
	// open and explain itself left this end of it untouched: a document
	// whose front matter will not parse is written, reported as drafted,
	// and never listed again.
	const complaints = explainDocumentFrontMatter(opts.scaffoldBody);
	if (complaints.length > 0) return undefined;
	const dir = join(state.questDir, subDir[opts.kind]);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${opts.id}.md`);
	// New document; scaffold atomically. Subsequent writes go
	// through writeDocumentStage which holds the lock too.
	atomicWriteUnderLock(state.questDir, path, opts.scaffoldBody);
	return path;
}
