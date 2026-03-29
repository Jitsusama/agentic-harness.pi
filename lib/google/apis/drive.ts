/**
 * Google Drive API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { DriveFile } from "../types.js";

/**
 * List Drive files with optional filtering.
 */
export async function listFiles(
	auth: OAuth2Client,
	options: {
		query?: string;
		folderId?: string;
		type?: "doc" | "sheet" | "slides" | "folder" | "pdf";
		owner?: "me" | string;
		shared?: boolean;
		sharedDriveId?: string;
		orderBy?: "modifiedTime" | "name" | "relevance";
		limit?: number;
		pageToken?: string;
	} = {},
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
	const drive = google.drive({ version: "v3", auth });

	// We build the query parts.
	const queryParts: string[] = ["trashed = false"];

	if (options.folderId) {
		queryParts.push(`'${options.folderId}' in parents`);
	}

	if (options.query) {
		queryParts.push(`fullText contains '${options.query}'`);
	}

	if (options.type) {
		const mimeType = getMimeType(options.type);
		if (mimeType.endsWith("/")) {
			queryParts.push(`mimeType contains '${mimeType}'`);
		} else {
			queryParts.push(`mimeType = '${mimeType}'`);
		}
	}

	if (options.owner === "me") {
		queryParts.push("'me' in owners");
	} else if (options.owner) {
		queryParts.push(`'${options.owner}' in owners`);
	}

	if (options.shared) {
		queryParts.push("sharedWithMe = true");
	}

	const q = queryParts.join(" and ");
	const orderBy = options.orderBy
		? options.orderBy === "relevance"
			? undefined
			: `${options.orderBy} desc`
		: "modifiedTime desc";

	const response = await drive.files.list({
		q,
		pageSize: options.limit || 25,
		orderBy,
		pageToken: options.pageToken,
		fields:
			"files(id,name,mimeType,size,modifiedTime,owners,webViewLink,iconLink),nextPageToken",
		...(options.sharedDriveId
			? {
					driveId: options.sharedDriveId,
					includeItemsFromAllDrives: true,
					supportsAllDrives: true,
				}
			: {}),
	});

	const files: DriveFile[] = (response.data.files || []).map((f) => ({
		id: f.id || "",
		name: f.name || "",
		mimeType: f.mimeType || "",
		size: f.size ? Number.parseInt(f.size, 10) : undefined,
		modifiedTime: f.modifiedTime || "",
		owners: (f.owners || []).map((o) => ({
			displayName: o.displayName || "",
			emailAddress: o.emailAddress || "",
		})),
		webViewLink: f.webViewLink || undefined,
		iconLink: f.iconLink || undefined,
	}));

	return {
		files,
		nextPageToken: response.data.nextPageToken || undefined,
	};
}

/**
 * Get file metadata.
 */
export async function getFileMetadata(
	auth: OAuth2Client,
	fileId: string,
): Promise<DriveFile> {
	const drive = google.drive({ version: "v3", auth });

	const response = await drive.files.get({
		fileId,
		fields:
			"id,name,mimeType,size,modifiedTime,createdTime,owners,webViewLink,iconLink,description",
		supportsAllDrives: true,
	});

	const f = response.data;
	return {
		id: f.id || "",
		name: f.name || "",
		mimeType: f.mimeType || "",
		size: f.size ? Number.parseInt(f.size, 10) : undefined,
		modifiedTime: f.modifiedTime || "",
		owners: (f.owners || []).map((o) => ({
			displayName: o.displayName || "",
			emailAddress: o.emailAddress || "",
		})),
		webViewLink: f.webViewLink || undefined,
		iconLink: f.iconLink || undefined,
	};
}

/**
 * List shared drives accessible to the user.
 */
export async function listSharedDrives(
	auth: OAuth2Client,
): Promise<Array<{ id: string; name: string }>> {
	const drive = google.drive({ version: "v3", auth });

	const response = await drive.drives.list({
		pageSize: 100,
		fields: "drives(id,name)",
	});

	return (response.data.drives || []).map((d) => ({
		id: d.id || "",
		name: d.name || "",
	}));
}

/**
 * Parse file ID from a Google URL.
 */
export function parseGoogleUrl(
	url: string,
): { id: string; type: string } | null {
	// We match against various Google URL patterns.
	const patterns = [
		// docs.google.com/document/d/FILE_ID/...
		/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
		// docs.google.com/spreadsheets/d/FILE_ID/...
		/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
		// docs.google.com/presentation/d/FILE_ID/...
		/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/,
		// drive.google.com/file/d/FILE_ID/...
		/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
		// drive.google.com/open?id=FILE_ID
		/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
	];

	for (const pattern of patterns) {
		const match = url.match(pattern);
		if (match?.[1]) {
			let type = "file";
			if (url.includes("/document/")) type = "doc";
			else if (url.includes("/spreadsheets/")) type = "sheet";
			else if (url.includes("/presentation/")) type = "slides";

			return { id: match[1], type };
		}
	}

	return null;
}

function getMimeType(type: string): string {
	const mimeTypes: Record<string, string> = {
		doc: "application/vnd.google-apps.document",
		document: "application/vnd.google-apps.document",
		sheet: "application/vnd.google-apps.spreadsheet",
		spreadsheet: "application/vnd.google-apps.spreadsheet",
		slides: "application/vnd.google-apps.presentation",
		presentation: "application/vnd.google-apps.presentation",
		folder: "application/vnd.google-apps.folder",
		pdf: "application/pdf",
		image: "image/",
		video: "video/",
	};

	return mimeTypes[type] || type;
}
