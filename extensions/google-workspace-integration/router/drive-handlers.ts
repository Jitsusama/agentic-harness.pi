/**
 * Drive action handlers.
 */

import type { OAuth2Client } from "google-auth-library";
import { getDocComments, getDocContent } from "../apis/docs.js";
import {
	getFileMetadata,
	listFiles,
	listSharedDrives,
	parseGoogleUrl,
} from "../apis/drive.js";
import { getSheetContent } from "../apis/sheets.js";
import { getSlideContent } from "../apis/slides.js";
import {
	renderDoc,
	renderFileList,
	renderSheet,
	renderSlides,
} from "../renderers/drive.js";
import {
	type ActionParams,
	getBooleanParam,
	getNumberParam,
	getStringParam,
	type ToolResult,
} from "../types.js";

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
	if (url && !fileId) {
		const parsed = parseGoogleUrl(url);
		if (!parsed) {
			return {
				content: [{ type: "text", text: `Could not parse Google URL: ${url}` }],
			};
		}
		fileId = parsed.id;
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
		return {
			content: [{ type: "text", text: renderDoc(file, content, comments) }],
			details: { file, content, comments },
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
