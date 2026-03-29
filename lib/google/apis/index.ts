/**
 * Google Workspace API clients: Calendar, Docs, Drive,
 * Gmail, Sheets and Slides.
 */

export {
	createEvent,
	deleteEvent,
	getEvent,
	listEvents,
	respondToEvent,
	updateEvent,
} from "./calendar.js";
export {
	type DocContent,
	getDocComments,
	getDocContent,
} from "./docs.js";
export {
	getFileMetadata,
	listFiles,
	listSharedDrives,
	parseGoogleUrl,
} from "./drive.js";
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
} from "./gmail.js";
export { getSheetContent, type SheetData } from "./sheets.js";
export { getSlideContent, type SlideData } from "./slides.js";
