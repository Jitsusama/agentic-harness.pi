/**
 * Google Workspace API clients: Calendar, Docs, Drive,
 * Gmail, Sheets and Slides.
 */

export {
	createEvent,
	deleteEvent,
	getEvent,
	listEvents,
	queryFreeBusy,
	respondToEvent,
	updateEvent,
} from "./calendar.ts";
export {
	type DocContent,
	type DocTab,
	getDocComments,
	getDocContent,
} from "./docs.ts";
export {
	getFileMetadata,
	listFiles,
	listSharedDrives,
	type ParsedGoogleUrl,
	parseGoogleUrl,
} from "./drive.ts";
export {
	archiveEmail,
	createDraft,
	deleteEmail,
	getEmail,
	getThread,
	markRead,
	markUnread,
	searchEmails,
	sendEmail,
	unarchiveEmail,
} from "./gmail.ts";
export { getSheetContent, type SheetData } from "./sheets.ts";
export { getSlideContent, type SlideData } from "./slides.ts";
