/**
 * What a terminal sends a pi that no one typed: focus reports and mouse
 * reports, read apart from keys.
 *
 * In fullscreen pi asks for focus reports (`?1004`) and every mouse
 * motion (`?1003`), so its input carries a report each time the window
 * gains or loses focus and each time the pointer crosses it. A listener
 * that takes every input for a key hears a person who just left, or who
 * only moved the mouse past, as one who is typing.
 */

/** Sent as the window gains focus. */
export const FOCUS_IN = "\x1b[I";

/** Sent as the window loses focus. */
export const FOCUS_OUT = "\x1b[O";

/** An SGR mouse report: button code, column and row, pressed or released. */
const SGR_MOUSE = new RegExp(
	`^${String.fromCharCode(27)}\\[<(\\d+);\\d+;\\d+[Mm]$`,
);

/** Set in an SGR button code when the report is of motion. */
const MOTION_BIT = 32;

/** The low bits of a button code that say no button is held. */
const NO_BUTTON = 3;

/** Where `data` is a focus report, which way focus went. */
export function focusReport(data: string): "in" | "out" | undefined {
	if (data === FOCUS_IN) return "in";
	if (data === FOCUS_OUT) return "out";
	return undefined;
}

/** A button code below this is a press or release, not motion or a scroll. */
const FIRST_NON_BUTTON = 32;

/** Whether `data` is a mouse button going down, rather than up, a scroll or motion. */
export function isPress(data: string): boolean {
	const code = SGR_MOUSE.exec(data)?.[1];
	return (
		code !== undefined && data.endsWith("M") && Number(code) < FIRST_NON_BUTTON
	);
}

/** Whether `data` is a mouse report of any kind. */
export function isMouseReport(data: string): boolean {
	return SGR_MOUSE.test(data);
}

/**
 * Whether `data` is the pointer moving with no button held, which says
 * only that it passed over the window. A drag holds a button and is a
 * person at work.
 */
export function isBareMotion(data: string): boolean {
	const code = SGR_MOUSE.exec(data)?.[1];
	if (code === undefined) return false;
	const button = Number(code);
	return (button & MOTION_BIT) !== 0 && (button & NO_BUTTON) === NO_BUTTON;
}

/**
 * Whether `data` says the person is at this window: a key, a click, a
 * scroll, a drag or focus arriving. Focus leaving and the pointer
 * passing over don't.
 */
export function meansPresence(data: string): boolean {
	return focusReport(data) !== "out" && !isBareMotion(data);
}

/** Whether `data` is a key, rather than a focus or mouse report. */
export function isTyped(data: string): boolean {
	return focusReport(data) === undefined && !isMouseReport(data);
}
