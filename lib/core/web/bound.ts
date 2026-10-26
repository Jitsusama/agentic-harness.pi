/**
 * Bounding work that waits on a browser.
 *
 * Nearly every wait in this layer is a request to Chrome, and Chrome
 * can simply not answer: a page that runs no script never finishes a
 * wait that needs one, and a wedged renderer never finishes anything.
 * Puppeteer's own bound is a three-minute protocol timeout per call,
 * which is a long time to hold a tool call a person is waiting on.
 *
 * The race itself lives in the clock module, since a language server
 * and an HTTP client need it as much as a browser does; this keeps the
 * name the browser layer has always imported it by.
 */

export {
	abortError,
	type Bounds,
	bounded,
	isAbort,
	WallClockExceeded,
} from "../clock/bound.ts";
