/**
 * Shared types used across the Google Workspace extension.
 */

/** Parameters passed to router actions. */
export type ActionParams = Record<string, unknown>;

/** Result of a tool execution. */
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

/** Google account configuration. */
export interface GoogleAccount {
	name: string;
	email?: string;
	isDefault: boolean;
}

/** Stored credentials for an account. */
export interface StoredCredentials {
	access_token: string;
	refresh_token: string;
	expiry_date: number;
	token_type: string;
	scope: string;
}

/** Gmail message metadata. */
export interface EmailMessage {
	id: string;
	threadId: string;
	subject: string;
	from: { name: string; email: string };
	to: Array<{ name: string; email: string }>;
	cc?: Array<{ name: string; email: string }>;
	date: string;
	snippet: string;
	labels: string[];
	hasAttachments: boolean;
}

/** Gmail message with full content. */
export interface EmailMessageFull extends EmailMessage {
	body: string;
	attachments: Array<{
		filename: string;
		mimeType: string;
		size: number;
	}>;
}

/** Calendar event. */
export interface CalendarEvent {
	id: string;
	summary: string;
	description?: string;
	location?: string;
	start: string; // ISO datetime
	end: string; // ISO datetime
	attendees?: Array<{
		email: string;
		displayName?: string;
		responseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
		self?: boolean;
	}>;
	conferenceData?: {
		entryPoints?: Array<{
			entryPointType: string;
			uri: string;
			label?: string;
		}>;
	};
	status?: string;
	htmlLink?: string;
}

/** Drive file metadata. */
export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: number;
	modifiedTime: string;
	owners?: Array<{
		displayName: string;
		emailAddress: string;
	}>;
	webViewLink?: string;
	iconLink?: string;
}

/** Document comment. */
export interface DocumentComment {
	id: string;
	content: string;
	author: {
		displayName: string;
		emailAddress?: string;
	};
	createdTime: string;
	resolved: boolean;
	replies?: Array<{
		content: string;
		author: {
			displayName: string;
			emailAddress?: string;
		};
		createdTime: string;
	}>;
}
