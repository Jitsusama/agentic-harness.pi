/**
 * A rename's workspace edit, laid on disk by pi for its server.
 *
 * The server names the files, and pi writes them outside any fence, so
 * under one every file is opened and judged before any is written, and
 * a file it may not write refuses the whole edit. Every file is written
 * before the server is told of any, each told on its own, so a file the
 * server moves since can't leave the rest unwritten. A write that fails
 * partway still tells the server of each file written, and says which.
 */

import { closeSync } from "node:fs";
import type { WorkspaceEdit as ProtocolWorkspaceEdit } from "vscode-languageserver-protocol";
import type { WorkspaceEdit } from "../types.ts";
import { editsByUri } from "./answers.ts";
import {
	applyProtocolEdits,
	fromProtocolRange,
	toLines,
	uriToFile,
} from "./document.ts";
import { openJudged, type Refuses, rewriteAt, textAt } from "./judged-files.ts";

/** One file's part of a workspace edit. */
type FileEdits = Parameters<typeof applyProtocolEdits>[1];

/** One file's change, in tool coordinates. */
type Change = WorkspaceEdit["changes"][number];

/** The server an edit is laid for: its name, its fence's judge, and how it is told. */
export interface EditedFor {
	readonly name: string;
	readonly refuses: Refuses | undefined;
	/** Tells the server a file now holds `text`, which pi wrote. */
	tell(path: string, text: string): void;
}

/**
 * Lays `edit` on disk, tells `server` of each file written, and says
 * what changed in tool coordinates.
 */
export function applyWorkspaceEdit(
	edit: ProtocolWorkspaceEdit,
	server: EditedFor,
): WorkspaceEdit {
	const opened: [string, number, FileEdits][] = [];
	const written: [Change, string][] = [];
	const told = () => {
		for (const [{ path }, updated] of written) {
			try {
				server.tell(path, updated);
			} catch {
				// It reads the file afresh at its next use.
			}
		}
	};
	try {
		for (const [uri, edits] of editsByUri(edit)) {
			try {
				const path = uriToFile(uri);
				opened.push([path, openJudged(path, "write", server.refuses), edits]);
			} catch (error) {
				throw new Error(
					`${server.name}'s rename wrote nothing: ${said(error)}`,
				);
			}
		}
		for (const [path, fd, edits] of opened) {
			try {
				written.push(rewrite(path, fd, edits));
			} catch (error) {
				told();
				const done = written.map(([change]) => change.path);
				throw new Error(
					`${server.name}'s rename wrote ${done.length} of ${opened.length} files (${done.join(", ") || "none"}) and failed at ${path}, which may be left part written: ${said(error)}`,
				);
			}
		}
		told();
		return { changes: written.map(([change]) => change) };
	} finally {
		for (const [, fd] of opened) closeSync(fd);
	}
}

/** Writes one file of an edit through `fd`: what changed, and its text now. */
function rewrite(path: string, fd: number, edits: FileEdits): [Change, string] {
	const original = textAt(fd);
	const updated = applyProtocolEdits(original, edits);
	rewriteAt(fd, updated);
	const lines = toLines(original);
	const change = {
		path,
		edits: edits.map((e) => ({
			range: fromProtocolRange(lines, e.range),
			newText: e.newText,
		})),
	};
	return [change, updated];
}

function said(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
