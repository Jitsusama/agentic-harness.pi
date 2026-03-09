/**
 * Email rendering to markdown.
 */

import type { EmailMessage, EmailMessageFull } from "../types.js";

/**
 * Render email list as markdown.
 */
export function renderEmailList(
	messages: EmailMessage[],
	nextPageToken?: string,
): string {
	if (messages.length === 0) {
		return "No emails found.";
	}

	const lines: string[] = ["# Emails\n"];

	for (const msg of messages) {
		const fromName = msg.from.name || msg.from.email;
		const subject = msg.subject;
		const date = formatDate(msg.date);
		const labels = filterInterestingLabels(msg.labels);
		const labelTags =
			labels.length > 0 ? ` ${labels.map((l) => `\`${l}\``).join(" ")}` : "";
		const attachmentIcon = msg.hasAttachments ? " 📎" : "";

		lines.push(`- **${subject}**${labelTags}${attachmentIcon}`);
		lines.push(`  ${fromName} · ${date} · \`${msg.id}\``);
		if (msg.snippet) {
			lines.push(
				`  ${msg.snippet.slice(0, 120)}${msg.snippet.length > 120 ? "..." : ""}`,
			);
		}
		lines.push("");
	}

	if (nextPageToken) {
		lines.push(`**Next page:** \`${nextPageToken}\``);
	}

	return lines.join("\n");
}

/**
 * Render a single email as markdown.
 */
export function renderEmail(msg: EmailMessageFull): string {
	const lines: string[] = [];

	lines.push(`# ${msg.subject}\n`);

	// Headers
	lines.push(`- **From:** ${formatEmailAddress(msg.from)}`);
	lines.push(`- **To:** ${msg.to.map(formatEmailAddress).join(", ")}`);
	if (msg.cc && msg.cc.length > 0) {
		lines.push(`- **Cc:** ${msg.cc.map(formatEmailAddress).join(", ")}`);
	}
	lines.push(`- **Date:** ${formatDate(msg.date)}`);
	lines.push(`- **ID:** \`${msg.id}\``);

	// Attachments
	if (msg.attachments.length > 0) {
		lines.push("\n## Attachments\n");
		for (const att of msg.attachments) {
			const size = formatSize(att.size);
			lines.push(`- ${att.filename} (${size})`);
		}
	}

	// Body
	lines.push("\n---\n");
	lines.push(msg.body);

	return lines.join("\n");
}

/**
 * Render email thread as markdown.
 */
export function renderThread(messages: EmailMessageFull[]): string {
	if (messages.length === 0) {
		return "No messages in thread.";
	}

	const lines: string[] = [];
	const subject = messages[0]?.subject || "Thread";

	lines.push(`# ${subject}`);
	lines.push(
		`\n_Thread with ${messages.length} message${messages.length !== 1 ? "s" : ""}_\n`,
	);

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;

		lines.push(`## Message ${i + 1}`);
		lines.push(`**From:** ${formatEmailAddress(msg.from)}`);
		lines.push(`**Date:** ${formatDate(msg.date)}`);
		lines.push(`**ID:** \`${msg.id}\`\n`);

		if (msg.attachments.length > 0) {
			lines.push("**Attachments:**");
			for (const att of msg.attachments) {
				lines.push(`- ${att.filename} (${formatSize(att.size)})`);
			}
			lines.push("");
		}

		lines.push(msg.body);
		lines.push("\n---\n");
	}

	return lines.join("\n");
}

// Helper functions

function formatEmailAddress(addr: { name: string; email: string }): string {
	if (addr.name) {
		return `${addr.name} <${addr.email}>`;
	}
	return addr.email;
}

function formatDate(dateStr: string): string {
	try {
		const date = new Date(dateStr);
		return date.toLocaleString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch (_error) {
		// Date parsing failed - return truncated raw string as fallback
		return dateStr.slice(0, 16);
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function filterInterestingLabels(labels: string[]): string[] {
	const skipLabels = new Set([
		"INBOX",
		"UNREAD",
		"CATEGORY_PRIMARY",
		"CATEGORY_SOCIAL",
		"CATEGORY_UPDATES",
		"CATEGORY_PROMOTIONS",
		"CATEGORY_FORUMS",
	]);

	return labels.filter((l) => !skipLabels.has(l));
}
