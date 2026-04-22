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

/** Maximum attempts when polling for share metadata. */
const SHARE_POLL_MAX_ATTEMPTS = 5;

/** Initial delay between share metadata polls (milliseconds). */
const SHARE_POLL_INITIAL_DELAY_MS = 500;

/**
 * Fetch the message timestamp from a file's share metadata.
 *
 * Uses files.info to look up the share entry for the given
 * channel. This is deterministic: we're reading metadata for
 * the exact file we just uploaded, not guessing based on
 * channel history.
 *
 * Slack processes file shares asynchronously, so the share
 * entry may not exist immediately after completeUploadExternal
 * returns. We poll with exponential backoff until it appears
 * or the attempt budget is exhausted.
 */
async function fetchShareTs(
	client: SlackClient,
	fileId: string,
	channelId: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	for (let attempt = 0; attempt < SHARE_POLL_MAX_ATTEMPTS; attempt++) {
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
		if (entries?.[0]?.ts) return entries[0].ts;

		// Share metadata isn't ready yet. Wait before retrying.
		const delay = SHARE_POLL_INITIAL_DELAY_MS * 2 ** attempt;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	return undefined;
}

/** MIME types recognised as images that the model can interpret. */
const IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/**
 * Application MIME types that contain readable text.
 *
 * These aren't under `text/` but the model can interpret
 * their content when decoded as UTF-8.
 */
const TEXT_APPLICATION_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
	"application/x-yaml",
	"application/x-sh",
	"application/sql",
	"application/graphql",
	"application/toml",
]);

/** Default maximum size for image files (5 MB). */
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Default maximum size for text files (128 KB). */
const DEFAULT_MAX_TEXT_BYTES = 128 * 1024;

/** Default maximum number of files to download per request. */
const DEFAULT_MAX_FILES = 10;

/** A downloaded file ready to be returned as model content. */
export type DownloadedFile =
	| { kind: "image"; data: string; mimeType: string; name: string }
	| { kind: "text"; text: string; name: string };

/**
 * Check whether a MIME type is a supported image format.
 *
 * Used to decide whether a file attachment should be
 * downloaded and sent to the model as image content.
 */
export function isImageMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const base = baseMimeType(mimeType);
	return IMAGE_MIME_TYPES.has(base);
}

/**
 * Check whether a MIME type is readable as text.
 *
 * Matches all `text/*` types and a curated set of
 * `application/*` types that contain human-readable content.
 */
export function isTextMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;
	const base = baseMimeType(mimeType);
	return base.startsWith("text/") || TEXT_APPLICATION_TYPES.has(base);
}

/** Strip parameters from a MIME type (e.g. "text/plain; charset=utf-8" → "text/plain"). */
function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0].trim().toLowerCase();
}

/** Options for downloading files from Slack messages. */
export interface FileDownloadOptions {
	signal?: AbortSignal;
	/** Maximum number of files to download (default: 10). */
	maxFiles?: number;
	/** Maximum size per image file in bytes (default: 5 MB). */
	maxImageBytes?: number;
	/** Maximum size per text file in bytes (default: 128 KB). */
	maxTextBytes?: number;
}

/**
 * Download displayable files from Slack messages.
 *
 * Filters files to supported image and text types, downloads
 * them via the authenticated client, and returns content
 * ready for model consumption. Images are base64-encoded;
 * text files are decoded as UTF-8. Skips files that are too
 * large or fail to download.
 */
export async function downloadFiles(
	client: SlackClient,
	files: Array<{ name: string; mimetype?: string; url?: string }>,
	opts?: FileDownloadOptions,
): Promise<DownloadedFile[]> {
	const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
	const maxImageBytes = opts?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
	const maxTextBytes = opts?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
	const results: DownloadedFile[] = [];

	for (const file of files) {
		if (results.length >= maxFiles) break;
		if (!file.url) continue;

		const isImage = isImageMimeType(file.mimetype);
		const isText = isTextMimeType(file.mimetype);
		if (!isImage && !isText) continue;

		const maxBytes = isImage ? maxImageBytes : maxTextBytes;

		try {
			const { buffer, contentType } = await client.download(file.url, {
				signal: opts?.signal,
				maxBytes,
			});

			if (isImage) {
				const mimeType = isImageMimeType(contentType)
					? baseMimeType(contentType)
					: (file.mimetype ?? "image/png");

				results.push({
					kind: "image",
					data: buffer.toString("base64"),
					mimeType,
					name: file.name,
				});
			} else {
				results.push({
					kind: "text",
					text: buffer.toString("utf-8"),
					name: file.name,
				});
			}
		} catch {
			// Download failed; skip this file silently.
			// The text renderer still shows the filename.
		}
	}

	return results;
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
