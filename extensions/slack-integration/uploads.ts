/**
 * Uploading files to Slack: which files an action names, what the
 * gate shows of them, and the upload itself.
 *
 * `upload_file` lands here, and so do `send_message` and
 * `reply_to_thread` when they carry files.
 */

import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getFileSize,
	type SlackClient,
	uploadFiles,
} from "../../lib/slack/index.ts";
import {
	type ActionParams,
	type ResolvedParams,
	stringParam,
	type ToolResult,
} from "../../lib/slack/types.ts";
import { OUTCOME_GLYPH } from "../../lib/ui/outcome-glyphs.ts";
import { confirmUploadFile, type FileInfo } from "./confirmation.ts";
import { missing, nameOf, text } from "./results.ts";

/**
 * Collect file paths from the file_path and file_paths params.
 *
 * Accepts either a single path or an array, or both. Returns
 * a deduplicated list.
 */
export function collectFilePaths(params: ActionParams): string[] {
	const paths: string[] = [];

	const single = stringParam(params, "file_path");
	if (single) paths.push(single);

	const multiple = params.file_paths;
	if (Array.isArray(multiple)) {
		for (const p of multiple) {
			if (typeof p === "string") paths.push(p);
		}
	}

	return [...new Set(paths)];
}

/**
 * Each file's name and size for a gate to show, or what to answer
 * when one isn't there.
 */
export async function fileInfosOf(
	filePaths: string[],
): Promise<FileInfo[] | string> {
	const fileInfos: FileInfo[] = [];
	for (const filePath of filePaths) {
		try {
			const size = await getFileSize(filePath);
			fileInfos.push({ name: basename(filePath), size });
		} catch {
			return `File not found: ${filePath}`;
		}
	}
	return fileInfos;
}

/** The `upload_file` action: files to a conversation or a thread. */
export async function handleUploadFile(
	client: SlackClient,
	params: ActionParams,
	resolved: ResolvedParams,
	ctx: ExtensionContext,
): Promise<ToolResult> {
	if (!resolved.conversation) return missing("channel");
	const filePaths = collectFilePaths(params);
	if (filePaths.length === 0) return missing("file_path or file_paths");

	return handleFileUpload(
		client,
		ctx,
		nameOf(resolved.conversation),
		filePaths,
		resolved.conversation.id,
		resolved.target?.ts,
		stringParam(params, "text"),
	);
}

/**
 * Shared file upload flow used by upload_file, send_message
 * and reply_to_thread when files are present.
 *
 * Validates files exist, shows the confirmation gate, then
 * uploads via the 3-step Slack external upload API.
 */
export async function handleFileUpload(
	client: SlackClient,
	ctx: ExtensionContext,
	displayName: string,
	filePaths: string[],
	channelId: string,
	threadTs?: string,
	initialComment?: string,
): Promise<ToolResult> {
	const fileInfos = await fileInfosOf(filePaths);
	if (typeof fileInfos === "string") return text(fileInfos);

	const confirmed = await confirmUploadFile(
		ctx,
		displayName,
		fileInfos,
		initialComment,
		threadTs,
	);
	if (!confirmed) return text(`${OUTCOME_GLYPH.cancelled} Upload cancelled.`);
	if (!confirmed.approved) return text(confirmed.redirect);

	const result = await uploadFiles(client, filePaths, {
		channelId,
		threadTs,
		initialComment,
	});

	const fileNames = fileInfos.map((f) => f.name).join(", ");
	const threadNote = threadTs ? ` in thread ${threadTs}` : "";
	return text(`✓ Uploaded ${fileNames} to ${displayName}${threadNote}`, {
		upload: result,
	});
}
