/**
 * Whether the page the server sent is the page the person got.
 *
 * The capture reads both renders from inside the page; the judge
 * is pure and takes serialized data, so it can judge a stored
 * capture as easily as a live one. Nothing here can start a
 * browser.
 */

export {
	HYDRATION_CAPTURE,
	type HydrationCapture,
	MAX_TEXT_CHARS,
	MAX_TEXTS,
	MIN_TEXT_CHARS,
} from "./capture.ts";
export {
	type ConsoleLine,
	type HydrationReport,
	judgeHydration,
	renderHydration,
	SHELL_FLOOR_TEXTS,
	SHELL_MIN_CLIENT_TEXTS,
	TAG_DRIFT_MIN,
	type TagDrift,
} from "./judge.ts";
