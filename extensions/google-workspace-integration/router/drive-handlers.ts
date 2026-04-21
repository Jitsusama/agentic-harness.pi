/**
 * Drive action handlers.
 */

import type { OAuth2Client } from "google-auth-library";
import {
	type DocTab,
	getDocComments,
	getDocContent,
} from "../../../lib/google/apis/docs.js";
import {
	getFileMetadata,
	listFiles,
	listSharedDrives,
	parseGoogleUrl,
} from "../../../lib/google/apis/drive.js";
import { getSheetContent } from "../../../lib/google/apis/sheets.js";
import { getSlideContent } from "../../../lib/google/apis/slides.js";
import {
	renderDoc,
	renderFileList,
	renderSheet,
	renderSlides,
} from "../../../lib/google/renderers/drive.js";
import {
	type ActionParams,
	getBooleanParam,
	getNumberParam,
	getStringParam,
	type ToolResult,
} from "../../../lib/google/types.js";

/** Search and list Google Drive files with optional filters. */
export async function handleListFiles(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const query = getStringParam(params, "query");
	const folderId = getStringParam(params, "folder_id");
	const type = getStringParam(params, "type");
	const owner = getStringParam(params, "owner");
	const shared = getBooleanParam(params, "shared");
	const sharedDriveId = getStringParam(params, "shared_drive_id");
	const orderBy = getStringParam(params, "order_by");
	const modifiedAfter = getStringParam(params, "modified_after");
	const modifiedBefore = getStringParam(params, "modified_before");
	const limit = getNumberParam(params, "limit");
	const pageToken = getStringParam(params, "page_token");

	const result = await listFiles(auth, {
		query,
		folderId,
		type: type as "doc" | "sheet" | "slides" | "folder" | "pdf" | undefined,
		owner,
		shared,
		sharedDriveId,
		orderBy: orderBy as "modifiedTime" | "name" | "relevance" | undefined,
		modifiedAfter,
		modifiedBefore,
		limit,
		pageToken,
	});

	return {
		content: [
			{
				type: "text",
				text: renderFileList(result.files, result.nextPageToken),
			},
		],
		details: result,
	};
}

/** Fetch a Google Drive file's content, routing by MIME type (Docs, Sheets, Slides). */
export async function handleGetFile(
	params: ActionParams,
	auth: OAuth2Client,
): Promise<ToolResult> {
	const id = getStringParam(params, "id");
	const url = getStringParam(params, "url");
	const includeComments = getBooleanParam(params, "include_comments");
	const commentsFilter = getStringParam(params, "comments_filter");

	// We parse the URL if one was provided.
	let fileId = id;
	let linkedTabId: string | undefined;
	if (url && !fileId) {
		const parsed = parseGoogleUrl(url);
		if (!parsed) {
			return {
				content: [{ type: "text", text: `Could not parse Google URL: ${url}` }],
			};
		}
		fileId = parsed.id;
		linkedTabId = parsed.tabId;
	}

	if (!fileId) {
		return {
			content: [
				{ type: "text", text: "Missing required parameter: id or url" },
			],
		};
	}

	// We get the file metadata.
	const file = await getFileMetadata(auth, fileId);
	const mime = file.mimeType;

	// We get the comments if requested.
	const comments = includeComments
		? await getDocComments(
				auth,
				fileId,
				commentsFilter as "all" | "resolved" | "unresolved" | undefined,
			)
		: undefined;

	// We route based on the MIME type.
	if (mime === "application/vnd.google-apps.document") {
		const content = await getDocContent(auth, fileId);
		const text = renderDoc(file, content, comments);

		// When the URL linked to a specific tab, add a hint
		// so the agent knows which tab was referenced.
		const linkedTabHint = linkedTabId
			? buildLinkedTabHint(linkedTabId, content.tabs)
			: undefined;
		const fullText = linkedTabHint ? `${text}\n---\n${linkedTabHint}` : text;

		return {
			content: [{ type: "text", text: fullText }],
			details: { file, content, comments, linkedTabId },
		};
	}

	if (mime === "application/vnd.google-apps.spreadsheet") {
		const content = await getSheetContent(auth, fileId);
		return {
			content: [{ type: "text", text: renderSheet(file, content, comments) }],
			details: { file, content, comments },
		};
	}

	if (mime === "application/vnd.google-apps.presentation") {
		const content = await getSlideContent(auth, fileId);
		return {
			content: [{ type: "text", text: renderSlides(file, content, comments) }],
			details: { file, content, comments },
		};
	}

	// For other file types, we just return the metadata.
	return {
		content: [
			{
				type: "text",
				text: `# ${file.name}\n\n- **Type:** ${file.mimeType}\n- **ID:** \`${file.id}\`\n- **Link:** ${file.webViewLink || "N/A"}`,
			},
		],
		details: { file },
	};
}

/**
 * Build a hint line identifying the tab that the URL linked to.
 */
function buildLinkedTabHint(
	linkedTabId: string,
	tabs: DocTab[],
): string | undefined {
	const tab = tabs.find((t) => t.id === linkedTabId);
	if (!tab) return undefined;
	return `**Linked tab:** ${tab.title} (\`${tab.id}\`)`;
}

/** List all shared drives the user has access to. */
export async function handleListSharedDrives(
	auth: OAuth2Client,
): Promise<ToolResult> {
	const drives = await listSharedDrives(auth);
	const lines = ["# Shared Drives\n"];
	for (const drive of drives) {
		lines.push(`- **${drive.name}** · \`${drive.id}\``);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { drives },
	};
}
