/**
 * Google Docs API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { DocumentComment } from "../types.js";

/** Extracted text content from a Google Doc. */
export interface DocContent {
	title: string;
	body: string;
}

/**
 * Get document content.
 */
export async function getDocContent(
	auth: OAuth2Client,
	documentId: string,
): Promise<DocContent> {
	const docs = google.docs({ version: "v1", auth });

	const doc = await docs.documents.get({
		documentId,
	});

	const title = doc.data.title || "Untitled";
	const body = extractDocBody(doc.data);

	return { title, body };
}

/**
 * Get comments on a document.
 */
export async function getDocComments(
	auth: OAuth2Client,
	documentId: string,
	filter?: "all" | "resolved" | "unresolved",
): Promise<DocumentComment[]> {
	const drive = google.drive({ version: "v3", auth });

	const response = await drive.comments.list({
		fileId: documentId,
		fields:
			"comments(id,content,author,createdTime,resolved,replies,quotedFileContent)",
		includeDeleted: false,
	});

	let comments = (response.data.comments || []).map(convertComment);

	// We filter by resolved status.
	if (filter === "resolved") {
		comments = comments.filter((c) => c.resolved);
	} else if (filter === "unresolved") {
		comments = comments.filter((c) => !c.resolved);
	}

	return comments;
}

function extractDocBody(doc: unknown): string {
	const d = doc as {
		body?: {
			content?: unknown[];
		};
	};

	if (!d.body?.content) return "";

	const lines: string[] = [];

	for (const element of d.body.content) {
		const el = element as {
			paragraph?: {
				elements?: unknown[];
				paragraphStyle?: { namedStyleType?: string };
			};
		};

		if (!el.paragraph) continue;

		const style = el.paragraph.paragraphStyle?.namedStyleType || "";
		let text = "";

		for (const elem of el.paragraph.elements || []) {
			const e = elem as {
				textRun?: { content?: string };
			};
			if (e.textRun?.content) {
				text += e.textRun.content;
			}
		}

		text = text.replace(/\n+$/, ""); // Trim trailing newlines

		if (!text) {
			lines.push("");
			continue;
		}

		// Handle headings
		if (style.startsWith("HEADING_")) {
			const level = Number.parseInt(style.replace("HEADING_", ""), 10);
			lines.push(`${"#".repeat(level)} ${text}`);
			lines.push("");
		} else {
			lines.push(text);
		}
	}

	return lines.join("\n");
}

function convertComment(comment: unknown): DocumentComment {
	const c = comment as {
		id?: string;
		content?: string;
		author?: {
			displayName?: string;
			emailAddress?: string;
		};
		createdTime?: string;
		resolved?: boolean;
		replies?: unknown[];
	};

	return {
		id: c.id || "",
		content: c.content || "",
		author: {
			displayName: c.author?.displayName || "",
			emailAddress: c.author?.emailAddress,
		},
		createdTime: c.createdTime || "",
		resolved: c.resolved || false,
		replies: (c.replies || []).map((r) => {
			const reply = r as {
				content?: string;
				author?: {
					displayName?: string;
					emailAddress?: string;
				};
				createdTime?: string;
			};

			return {
				content: reply.content || "",
				author: {
					displayName: reply.author?.displayName || "",
					emailAddress: reply.author?.emailAddress,
				},
				createdTime: reply.createdTime || "",
			};
		}),
	};
}
