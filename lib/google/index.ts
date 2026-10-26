/**
 * Google Workspace library: API clients, credential state,
 * renderers and shared types.
 *
 * Public entry point for external consumers, with
 * `ensureAuthenticated`, which runs the setup wizard and the
 * device or web sign-in in pi's own interface.
 */

export * from "./apis/index.ts";
export * from "./auth/index.ts";
export * from "./renderers/index.ts";

// Re-export domain types (omit router internals).
export type {
	BusyPeriod,
	CalendarEvent,
	CalendarFreeBusy,
	DocumentComment,
	DriveFile,
	EmailMessage,
	EmailMessageFull,
	FreeBusyResult,
	GoogleAccount,
	StoredCredentials,
} from "./types.ts";
