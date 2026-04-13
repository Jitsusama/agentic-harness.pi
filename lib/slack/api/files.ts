/**
 * Slack file upload API using the V2 external upload flow.
 *
 * Implements the 3-step upload process:
 * 1. Get an upload URL via files.getUploadURLExternal
 * 2. POST file bytes to that URL
 * 3. Finalize with files.completeUploadExternal
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { SlackClient } from "./client.js";

/** Result from completing a file upload. */
export interface UploadResult {
	ok: boolean;
	files: Array<{ id: string; title?: string }>;
	/**
	 * Timestamp of the message created when sharing to a channel.
	 * Only present when channelId was provided.
	 */
	ts?: string;
}

/** Options for sharing uploaded files. */
export interface UploadOptions {
	/** Channel ID to share the files in. */
	channelId?: string;
	/** Thread timestamp to upload as a reply. */
	threadTs?: string;
	/** Message text introducing the files. */
	initialComment?: string;
}

/**
 * Upload one or more local files to Slack.
 *
 * Each file goes through the external upload flow
 * individually, then all are finalized in a single
 * completeUploadExternal call to share them together.
 */
export async function uploadFiles(
	client: SlackClient,
	filePaths: string[],
	opts: UploadOptions = {},
	signal?: AbortSignal,
): Promise<UploadResult> {
	if (filePaths.length === 0) {
		throw new Error("No file paths provided.");
	}

	const fileIds: Array<{ id: string }> = [];

	for (const filePath of filePaths) {
		const fileId = await uploadSingleFile(client, filePath, signal);
		fileIds.push({ id: fileId });
	}

	return completeUpload(client, fileIds, opts, signal);
}

/**
 * Upload a single file and return its Slack file ID.
 *
 * Gets an upload URL, reads the file from disk, then
 * POSTs the bytes to Slack's upload endpoint.
 */
async function uploadSingleFile(
	client: SlackClient,
	filePath: string,
	signal?: AbortSignal,
): Promise<string> {
	const fileBytes = await readFile(filePath);
	const filename = basename(filePath);

	const urlResponse = await client.call<{
		upload_url: string;
		file_id: string;
	}>(
		"files.getUploadURLExternal",
		{ filename, length: fileBytes.length },
		signal,
	);

	await client.upload(urlResponse.upload_url, fileBytes, signal);

	return urlResponse.file_id;
}

/**
 * Finalize uploaded files and optionally share them.
 *
 * Calls files.completeUploadExternal with the collected
 * file IDs and any sharing parameters (channel, thread,
 * initial comment).
 */
async function completeUpload(
	client: SlackClient,
	fileIds: Array<{ id: string }>,
	opts: UploadOptions,
	signal?: AbortSignal,
): Promise<UploadResult> {
	const params: Record<string, string | undefined> = {
		files: JSON.stringify(fileIds),
		channel_id: opts.channelId,
		thread_ts: opts.threadTs,
		initial_comment: opts.initialComment,
	};

	const response = await client.call<{
		files: Array<{ id: string; title?: string }>;
	}>("files.completeUploadExternal", params, signal);

	const result: UploadResult = {
		ok: true,
		files: response.files ?? [],
	};

	// completeUploadExternal doesn't return the message ts.
	// When sharing to a channel, recover it from the file's
	// share metadata via files.info. This is deterministic
	// (keyed on the file we just uploaded) so there's no
	// race with other messages landing in the channel.
	if (opts.channelId && result.files.length > 0) {
		result.ts = await fetchShareTs(
			client,
			result.files[0].id,
			opts.channelId,
			signal,
		);
	}

	return result;
}

/** Share metadata shape from the files.info response. */
interface FileShareEntry {
	ts: string;
	thread_ts?: string;
}

/**
 * Fetch the message timestamp from a file's share metadata.
 *
 * Uses files.info to look up the share entry for the given
 * channel. This is deterministic: we're reading metadata for
 * the exact file we just uploaded, not guessing based on
 * channel history.
 */
async function fetchShareTs(
	client: SlackClient,
	fileId: string,
	channelId: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const response = await client.call<{
		file?: {
			shares?: {
				public?: Record<string, FileShareEntry[]>;
				private?: Record<string, FileShareEntry[]>;
			};
		};
	}>("files.info", { file: fileId }, signal);

	const shares = response.file?.shares;
	const entries = shares?.public?.[channelId] ?? shares?.private?.[channelId];
	return entries?.[0]?.ts;
}

/**
 * Get the byte size of a local file.
 *
 * Used by callers to display file sizes in confirmation
 * gates before uploading.
 */
export async function getFileSize(filePath: string): Promise<number> {
	const info = await stat(filePath);
	return info.size;
}
