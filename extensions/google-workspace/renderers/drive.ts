/**
 * Drive file rendering to markdown.
 */

import type { DocContent } from "../apis/docs.js";
import type { SheetData } from "../apis/sheets.js";
import type { SlideData } from "../apis/slides.js";
import type { DocumentComment, DriveFile } from "../types.js";

/**
 * Render Drive file list as markdown.
 */
export function renderFileList(
	files: DriveFile[],
	nextPageToken?: string,
): string {
	if (files.length === 0) {
		return "No files found.";
	}

	const lines: string[] = ["# Drive Files\n"];

	for (const file of files) {
		const icon = getMimeIcon(file.mimeType);
		const size = file.size ? formatSize(file.size) : "";
		const owner =
			file.owners && file.owners.length > 0 ? file.owners[0]?.displayName : "";
		const sizeStr = size ? ` · ${size}` : "";
		const ownerStr = owner ? ` · ${owner}` : "";
		const modified = file.modifiedTime.slice(0, 10);

		lines.push(`- ${icon} **${file.name}**${sizeStr}${ownerStr}`);
		lines.push(`  Modified: ${modified} · \`${file.id}\``);
		lines.push("");
	}

	if (nextPageToken) {
		lines.push(`**Next page:** \`${nextPageToken}\``);
	}

	return lines.join("\n");
}

/**
 * Render a Google Doc as markdown.
 */
export function renderDoc(
	file: DriveFile,
	content: DocContent,
	comments?: DocumentComment[],
): string {
	const lines: string[] = [];

	lines.push(`# 📝 ${content.title}\n`);
	lines.push(`Last modified: ${file.modifiedTime.slice(0, 10)}`);
	if (file.owners && file.owners.length > 0) {
		lines.push(`Owner: ${file.owners[0]?.displayName}`);
	}
	lines.push(`ID: \`${file.id}\``);
	if (file.webViewLink) {
		lines.push(`Link: ${file.webViewLink}`);
	}
	lines.push("\n---\n");
	lines.push(content.body);

	if (comments && comments.length > 0) {
		lines.push("\n---\n");
		lines.push(renderComments(comments));
	}

	return lines.join("\n");
}

/**
 * Render a Google Sheet as markdown.
 */
export function renderSheet(
	file: DriveFile,
	content: SheetData,
	comments?: DocumentComment[],
): string {
	const lines: string[] = [];

	lines.push(`# 📊 ${content.title}\n`);
	lines.push(`Last modified: ${file.modifiedTime.slice(0, 10)}`);
	if (file.owners && file.owners.length > 0) {
		lines.push(`Owner: ${file.owners[0]?.displayName}`);
	}
	lines.push(`ID: \`${file.id}\``);
	if (file.webViewLink) {
		lines.push(`Link: ${file.webViewLink}`);
	}
	lines.push("");

	for (const sheet of content.sheets) {
		lines.push(`## ${sheet.name}\n`);

		if (sheet.rows.length === 0) {
			lines.push("_(empty sheet)_\n");
			continue;
		}

		// Render as markdown table
		const header = sheet.rows[0] || [];
		const dataRows = sheet.rows.slice(1);

		lines.push(`| ${header.join(" | ")} |`);
		lines.push(`| ${header.map(() => "---").join(" | ")} |`);

		for (const row of dataRows) {
			// Pad row to match header length
			const paddedRow = [...row];
			while (paddedRow.length < header.length) {
				paddedRow.push("");
			}
			lines.push(`| ${paddedRow.slice(0, header.length).join(" | ")} |`);
		}

		lines.push("");
	}

	if (comments && comments.length > 0) {
		lines.push("---\n");
		lines.push(renderComments(comments));
	}

	return lines.join("\n");
}

/**
 * Render Google Slides as markdown.
 */
export function renderSlides(
	file: DriveFile,
	content: SlideData,
	comments?: DocumentComment[],
): string {
	const lines: string[] = [];

	lines.push(`# 📽️ ${content.title}\n`);
	lines.push(`Last modified: ${file.modifiedTime.slice(0, 10)}`);
	if (file.owners && file.owners.length > 0) {
		lines.push(`Owner: ${file.owners[0]?.displayName}`);
	}
	lines.push(`ID: \`${file.id}\``);
	if (file.webViewLink) {
		lines.push(`Link: ${file.webViewLink}`);
	}
	lines.push("");

	for (const slide of content.slides) {
		lines.push(`## Slide ${slide.number}\n`);
		lines.push(slide.text || "_(no text)_");
		lines.push("");
	}

	if (comments && comments.length > 0) {
		lines.push("---\n");
		lines.push(renderComments(comments));
	}

	return lines.join("\n");
}

/**
 * Render document comments.
 */
export function renderComments(comments: DocumentComment[]): string {
	if (comments.length === 0) {
		return "";
	}

	const unresolved = comments.filter((c) => !c.resolved).length;
	const resolved = comments.length - unresolved;

	const lines: string[] = [];
	lines.push(
		`## Comments (${unresolved} unresolved${resolved > 0 ? `, ${resolved} resolved` : ""})\n`,
	);

	for (const comment of comments) {
		const status = comment.resolved ? "✓ Resolved" : "Open";
		const author = comment.author.displayName;
		const date = comment.createdTime.slice(0, 10);

		lines.push(`**${author}** · ${date} · ${status}`);
		lines.push(`> ${comment.content}\n`);

		if (comment.replies && comment.replies.length > 0) {
			for (const reply of comment.replies) {
				const replyAuthor = reply.author.displayName;
				const replyDate = reply.createdTime.slice(0, 10);
				lines.push(`  **${replyAuthor}** · ${replyDate}`);
				lines.push(`  > ${reply.content}\n`);
			}
		}
	}

	return lines.join("\n");
}

function getMimeIcon(mimeType: string): string {
	const icons: Record<string, string> = {
		"application/vnd.google-apps.folder": "📁",
		"application/vnd.google-apps.document": "📝",
		"application/vnd.google-apps.spreadsheet": "📊",
		"application/vnd.google-apps.presentation": "📽️",
		"application/vnd.google-apps.form": "📋",
		"application/pdf": "📄",
	};

	for (const [prefix, icon] of Object.entries(icons)) {
		if (mimeType.startsWith(prefix)) {
			return icon;
		}
	}

	if (mimeType.startsWith("image/")) return "🖼️";
	if (mimeType.startsWith("video/")) return "🎬";
	if (mimeType.startsWith("audio/")) return "🎵";

	return "📎";
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
