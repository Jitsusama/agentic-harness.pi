/**
 * What the page said, and how to read it back.
 *
 * Chrome hands over console arguments as remote object
 * descriptions rather than text: it never renders them, because
 * rendering is the front end's job. Everything here is that
 * front end, and is therefore presentation by definition. The
 * facts, the types, the values and the previews, are the
 * browser's; the shape they are read in is ours.
 */

/** A property inside a preview Chrome sends. */
export interface RemotePreviewProperty {
	readonly name: string;
	readonly type: string;
	readonly subtype?: string;
	readonly value?: string;
}

/** Chrome's summary of an object it will not send whole. */
export interface RemotePreview {
	readonly type: string;
	readonly subtype?: string;
	readonly description?: string;
	readonly overflow?: boolean;
	readonly properties?: readonly RemotePreviewProperty[];
}

/** One console argument as the protocol describes it. */
export interface RemoteArg {
	readonly type: string;
	readonly subtype?: string;
	readonly className?: string;
	readonly description?: string;
	readonly value?: unknown;
	readonly objectId?: string;
	readonly preview?: RemotePreview;
}

/** How many preview properties are worth showing before it stops helping. */
const MAX_PREVIEW_PROPERTIES = 8;

/**
 * One console argument, as the developer would have seen it.
 *
 * Strings read bare, because that is how a logged message
 * reads; a string nested inside an object is quoted, because
 * there the quoting is what distinguishes it from a name.
 */
export function renderArg(arg: RemoteArg): string {
	if (arg.type === "undefined") return "undefined";
	if (arg.subtype === "null") return "null";
	if (arg.type === "string") return String(arg.value ?? arg.description ?? "");
	if (arg.type === "bigint") return arg.description ?? String(arg.value);
	if (arg.type === "number" || arg.type === "boolean") {
		return arg.value !== undefined
			? String(arg.value)
			: (arg.description ?? "");
	}

	// An error's description carries the whole stack. The message
	// is the first line; the rest belongs to the entry's own stack
	// field, where it is not repeated for every argument.
	if (arg.subtype === "error" && arg.description) {
		return arg.description.split("\n")[0] ?? arg.description;
	}

	// A node prints as the selector-ish description Chrome gives,
	// not as its property bag, which is all attributes and noise.
	if (arg.subtype === "node") return arg.description ?? "node";

	const preview = arg.preview;
	if (preview?.properties) {
		const isArray = preview.subtype === "array" || arg.subtype === "array";
		const shown = preview.properties.slice(0, MAX_PREVIEW_PROPERTIES);
		const parts = shown.map((property) =>
			isArray
				? previewValue(property)
				: `${property.name}: ${previewValue(property)}`,
		);
		const cut = preview.overflow || shown.length < preview.properties.length;
		if (cut) parts.push("...");
		return isArray ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
	}

	return arg.description ?? arg.className ?? arg.type;
}

/** One line of what the page said. */
export interface LogEntry {
	readonly source: string;
	readonly level: string;
	readonly text: string;
	readonly timestamp: number;
	readonly origin?: string;
	readonly stack?: string;
	readonly requestId?: string;
}

/** One frame of a stack Chrome captured. */
export interface CallFrame {
	readonly functionName: string;
	readonly url: string;
	readonly lineNumber: number;
	readonly columnNumber: number;
}

/** Runtime.consoleAPICalled, as the protocol sends it. */
export interface ConsoleCalled {
	readonly type: string;
	readonly timestamp: number;
	readonly args: readonly RemoteArg[];
	readonly stackTrace?: { readonly callFrames: readonly CallFrame[] };
}

/**
 * Runtime.exceptionThrown's details, as the protocol sends
 * them. The timestamp is not in here: it belongs to the event
 * that carried the details, and is passed alongside.
 */
export interface ExceptionThrown {
	readonly text: string;
	readonly url?: string;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
	readonly exception?: RemoteArg;
	readonly stackTrace?: { readonly callFrames: readonly CallFrame[] };
}

/** Log.entryAdded's entry, as the protocol sends it. */
export interface BrowserLogged {
	readonly source: string;
	readonly level: string;
	readonly text: string;
	readonly timestamp: number;
	readonly url?: string;
	readonly lineNumber?: number;
	readonly networkRequestId?: string;
	readonly stackTrace?: { readonly callFrames: readonly CallFrame[] };
}

/**
 * The text of a console call, directives and all.
 *
 * Chrome sends the arguments exactly as they were passed and
 * substitutes nothing, because substitution is the front end's
 * job. Doing it here is what makes the line read the way the
 * developer saw it in their own console rather than as a
 * format string followed by loose values.
 */
export function consoleText(args: readonly RemoteArg[]): string {
	if (args.length === 0) return "";

	const [first, ...rest] = args;
	if (first === undefined) return "";
	const pending = [...rest];
	const formatted =
		first.type === "string"
			? substitute(String(first.value ?? ""), pending)
			: renderArg(first);

	return [formatted, ...pending.map(renderArg)].filter(Boolean).join(" ");
}

/**
 * Fill a format string from the arguments, consuming as it
 * goes, so whatever is left over can be appended.
 */
function substitute(format: string, pending: RemoteArg[]): string {
	return format.replace(/%[sdifoOjc%]/g, (directive) => {
		if (directive === "%%") return "%";
		// A directive with nothing left to fill it is not a
		// directive; "100%s complete" is a sentence about percent.
		if (pending.length === 0) return directive;

		const arg = pending.shift();
		if (arg === undefined) return directive;
		// %c consumes its styling and shows nothing: this is text.
		if (directive === "%c") return "";
		if (directive === "%d" || directive === "%i") {
			const value = Number(arg.value ?? arg.description);
			return Number.isFinite(value)
				? String(Math.trunc(value))
				: renderArg(arg);
		}
		return renderArg(arg);
	});
}

/** A console call, as a log entry. */
export function consoleEntry(event: ConsoleCalled): LogEntry {
	const origin = originOf(event.stackTrace?.callFrames);
	return {
		source: "console",
		// Chrome's own vocabulary, kept as sent: it says "warning",
		// not "warn", and renaming it would invent a third dialect.
		level: event.type,
		text: consoleText(event.args),
		timestamp: event.timestamp,
		...(origin === undefined ? {} : { origin }),
		...stackOf(event.stackTrace?.callFrames),
	};
}

/**
 * A thrown exception, as a log entry.
 *
 * The protocol's own text is only "Uncaught", or "Uncaught (in
 * promise)" when a rejection went unhandled. That prefix says
 * how the throw escaped and is worth keeping, but the message
 * itself lives on the thrown value.
 */
export function exceptionEntry(
	details: ExceptionThrown,
	timestamp: number,
): LogEntry {
	const thrown = details.exception ? renderArg(details.exception) : "";
	const description = details.exception?.description ?? "";
	const stack = description.includes("\n")
		? description.slice(description.indexOf("\n") + 1)
		: undefined;
	const origin = locationOf(
		details.url,
		details.lineNumber,
		details.columnNumber,
	);

	return {
		source: "exception",
		level: "error",
		text: [details.text, thrown].filter(Boolean).join(" "),
		timestamp,
		...(origin === undefined ? {} : { origin }),
		...(stack === undefined ? {} : { stack }),
	};
}

/**
 * A browser-generated message, as a log entry.
 *
 * These are the ones the page's own console never sees: a
 * resource that failed to load, a blocked mixed-content
 * request, a deprecation. Missing them is how a broken image
 * goes unnoticed.
 */
export function browserEntry(entry: BrowserLogged): LogEntry {
	const origin = locationOf(entry.url, entry.lineNumber);
	return {
		source: entry.source,
		level: entry.level,
		text: entry.text,
		timestamp: entry.timestamp,
		...(origin === undefined ? {} : { origin }),
		...(entry.networkRequestId === undefined
			? {}
			: { requestId: entry.networkRequestId }),
		...stackOf(entry.stackTrace?.callFrames),
	};
}

/** Where a call came from: the innermost frame that has a url. */
function originOf(
	frames: readonly CallFrame[] | undefined,
): string | undefined {
	const frame = frames?.find((candidate) => candidate.url);
	return frame
		? locationOf(frame.url, frame.lineNumber, frame.columnNumber)
		: undefined;
}

/** The rest of the stack, when there is more than one frame. */
function stackOf(frames: readonly CallFrame[] | undefined): { stack?: string } {
	if (!frames || frames.length < 2) return {};
	return {
		stack: frames
			.map(
				(frame) =>
					`    at ${frame.functionName || "(anonymous)"} ` +
					`${locationOf(frame.url, frame.lineNumber, frame.columnNumber)}`,
			)
			.join("\n"),
	};
}

/**
 * A url with its position, counted from one.
 *
 * The protocol counts lines and columns from zero; every editor
 * and every stack trace a developer reads counts from one.
 */
function locationOf(
	url: string | undefined,
	line?: number,
	column?: number,
): string | undefined {
	if (!url) return undefined;
	if (line === undefined) return url;
	const place = `${url}:${line + 1}`;
	return column === undefined ? place : `${place}:${column + 1}`;
}

/** A preview property's value, quoted when a string. */
function previewValue(property: RemotePreviewProperty): string {
	if (property.type === "string") return JSON.stringify(property.value ?? "");
	return property.value ?? property.type;
}
