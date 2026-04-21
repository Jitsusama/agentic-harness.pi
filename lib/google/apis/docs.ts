/**
 * Google Docs API client.
 */

import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import type { DocumentComment } from "../types.js";

/** A single tab within a Google Doc. */
export interface DocTab {
	id: string;
	title: string;
	body: string;
	/** Nesting depth: 0 for root tabs, 1 for children, 2 for grandchildren. */
	nestingLevel: number;
}

/** Extracted text content from a Google Doc. */
export interface DocContent {
	title: string;
	/** Combined body text from all tabs (for backward compatibility). */
	body: string;
	/** Individual tabs with their own title and content. */
	tabs: DocTab[];
}

/**
 * Get document content, including all tabs.
 */
export async function getDocContent(
	auth: OAuth2Client,
	documentId: string,
): Promise<DocContent> {
	const docs = google.docs({ version: "v1", auth });

	// The includeTabsContent parameter is supported by the
	// REST API but missing from the googleapis v140 types.
	const doc = await docs.documents.get({
		documentId,
		includeTabsContent: true,
	} as Parameters<typeof docs.documents.get>[0]);

	const title = doc.data.title || "Untitled";
	const rawTabs = (doc.data as DocumentWithTabs).tabs;

	if (rawTabs && rawTabs.length > 0) {
		const multiTab = rawTabs.length > 1 || hasChildTabs(rawTabs);
		const tabs = flattenTabs(rawTabs, multiTab);
		const body = tabs.map((t) => t.body).join("\n\n");
		return { title, body, tabs };
	}

	// When includeTabsContent is true the API empties
	// document.body, so we can't read it as a fallback.
	// Re-fetch without the flag to get first-tab content.
	const fallback = await docs.documents.get({ documentId });
	const body = extractBodyContent(fallback.data.body);
	return {
		title,
		body,
		tabs: [{ id: "", title: "Tab 1", body, nestingLevel: 0 }],
	};
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

// --- Tab response types (not yet in googleapis v140) ---

/** Shape of a Tab object from the Docs API response. */
interface ApiTab {
	tabProperties?: {
		tabId?: string;
		title?: string;
		nestingLevel?: number;
	};
	documentTab?: {
		body?: { content?: unknown[] };
	};
	childTabs?: ApiTab[];
}

/** Document response when includeTabsContent is true. */
interface DocumentWithTabs {
	tabs?: ApiTab[];
}

/** Check whether any tab in the list has children. */
function hasChildTabs(tabs: ApiTab[]): boolean {
	return tabs.some((t) => t.childTabs && t.childTabs.length > 0);
}

/**
 * Recursively flatten the tab tree into an ordered list
 * matching the UI's top-down tab order.
 */
function flattenTabs(tabs: ApiTab[], multiTab: boolean): DocTab[] {
	const result: DocTab[] = [];
	for (const tab of tabs) {
		const id = tab.tabProperties?.tabId || "";
		const title = tab.tabProperties?.title || "Untitled tab";
		const nestingLevel = tab.tabProperties?.nestingLevel ?? 0;

		// In multi-tab documents, shift body headings so they
		// nest below the tab's own heading. The tab heading is
		// at level nestingLevel + 2, so body headings start one
		// level deeper. Single-tab docs render flat (no tab
		// heading), so body headings stay at their native level.
		const headingOffset = multiTab ? nestingLevel + 2 : 0;
		const body = extractBodyContent(tab.documentTab?.body, headingOffset);

		result.push({ id, title, body, nestingLevel });
		if (tab.childTabs && tab.childTabs.length > 0) {
			result.push(...flattenTabs(tab.childTabs, multiTab));
		}
	}
	return result;
}

/** Markdown supports heading levels 1–6. */
const MAX_HEADING_LEVEL = 6;

/**
 * Extract text content from a Docs API body object.
 *
 * When `headingOffset` is non-zero, document headings are
 * shifted so they nest below a parent tab heading. A
 * HEADING_1 with offset 2 becomes `###` (level 3). Levels
 * that would exceed 6 are clamped at `######`.
 */
function extractBodyContent(
	body: { content?: unknown[] } | undefined | null,
	headingOffset = 0,
): string {
	if (!body?.content) return "";

	const lines: string[] = [];

	for (const element of body.content) {
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

		// Headings get converted to markdown heading syntax.
		if (style.startsWith("HEADING_")) {
			const docLevel = Number.parseInt(style.replace("HEADING_", ""), 10);
			const level = Math.min(docLevel + headingOffset, MAX_HEADING_LEVEL);
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
