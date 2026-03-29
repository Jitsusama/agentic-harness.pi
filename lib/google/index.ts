/**
 * Google Workspace library: API clients, authentication,
 * renderers and shared types.
 *
 * Public entry point for external consumers.
 */

export * from "./apis/index.js";
export * from "./auth/index.js";
export * from "./renderers/index.js";

// Re-export domain types (omit router internals).
export type {
	CalendarEvent,
	DocumentComment,
	DriveFile,
	EmailMessage,
	EmailMessageFull,
	GoogleAccount,
	StoredCredentials,
} from "./types.js";
