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
} from "./capture.ts";
export {
	judgeHydration,
	renderHydration,
} from "./judge.ts";
