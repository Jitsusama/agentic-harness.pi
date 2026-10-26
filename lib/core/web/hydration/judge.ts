/**
 * Whether the page the server sent is the page the person got.
 *
 * A hydration mismatch ships silently: the markup is valid, the
 * console line scrolls past, and the visitor sees content flash,
 * flip or vanish. The judgment here is over three kinds of
 * evidence: content in the server render that is gone after
 * hydration, content that only exists after hydration, and the
 * framework's own hydration warnings caught in the console.
 *
 * Framework-agnostic on purpose. The console recognizers know
 * the words React and Vue use, but the DOM comparison knows
 * nothing about any framework: a server render and a hydrated
 * document disagree or they do not.
 *
 * Adapted from the hydration-safety check in Carolyn McNeillie's
 * review-page skill set, generalized from its React framing.
 */

import { count, renderVerdict, type Standing } from "../audit/verdict.ts";
import type { HydrationCapture } from "./capture.ts";

/** One console line, as the session's telemetry records it. */
export interface ConsoleLine {
	readonly level: string;
	readonly text: string;
}

/** A tag whose count moved between the renders. */
export interface TagDrift {
	readonly tag: string;
	readonly server: number;
	readonly client: number;
}

/** Everything the judge concluded. */
export interface HydrationReport {
	readonly standing: Standing;
	/** Server content that is gone after hydration. */
	readonly vanished: readonly string[];
	/** Content that only exists after hydration. */
	readonly appeared: readonly string[];
	readonly drift: readonly TagDrift[];
	/** The framework's own hydration complaints. */
	readonly warnings: readonly string[];
	/** True when there was no server render worth comparing. */
	readonly shell: boolean;
	readonly fetched: boolean;
	readonly status?: number;
}

/**
 * What a hydration complaint looks like in a console.
 *
 * React 17 says "Text content does not match server-rendered
 * HTML", React 18 and 19 say "Hydration failed" and "an error
 * occurred during hydration", Vue says "Hydration node mismatch".
 * The word stem covers all but the first, which gets its own
 * pattern.
 */
const COMPLAINTS = [/hydrat/i, /did not match/i, /server.rendered/i];

/** Console levels worth reading complaints from. */
const SPOKEN_LEVELS = new Set(["error", "warning", "warn"]);

/** Fewer server texts than this is a shell, not a render. */
export const SHELL_FLOOR_TEXTS = 5;

/** ...when the client has at least this many. */
export const SHELL_MIN_CLIENT_TEXTS = 20;

/** A tag count moving less than this is churn, not drift. */
export const TAG_DRIFT_MIN = 5;

function multiset(texts: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
	return counts;
}

function difference(
	from: readonly string[],
	take: readonly string[],
): readonly string[] {
	const remaining = multiset(take);
	const out: string[] = [];
	for (const text of from) {
		const left = remaining.get(text) ?? 0;
		if (left > 0) {
			remaining.set(text, left - 1);
		} else {
			out.push(text);
		}
	}
	return out;
}

/** Judge a capture beside what the console said during load. */
export function judgeHydration(
	capture: HydrationCapture,
	consoleLines: readonly ConsoleLine[] = [],
): HydrationReport {
	const warnings = consoleLines
		.filter((line) => SPOKEN_LEVELS.has(line.level))
		.filter((line) => COMPLAINTS.some((pattern) => pattern.test(line.text)))
		.map((line) => line.text);

	const base = {
		warnings,
		fetched: capture.fetched,
		...(capture.status === undefined ? {} : { status: capture.status }),
	};

	if (!capture.fetched) {
		return {
			...base,
			standing: warnings.length > 0 ? "fail" : "warn",
			vanished: [],
			appeared: [],
			drift: [],
			shell: false,
		};
	}

	// A client-rendered page has no server render to hold it to:
	// every text would read as appeared, which is noise about an
	// architecture, not findings about a bug.
	const shell =
		capture.serverTexts.length < SHELL_FLOOR_TEXTS &&
		capture.clientTexts.length >= SHELL_MIN_CLIENT_TEXTS;
	if (shell) {
		return {
			...base,
			standing: warnings.length > 0 ? "fail" : "warn",
			vanished: [],
			appeared: [],
			drift: [],
			shell: true,
		};
	}

	const vanished = difference(capture.serverTexts, capture.clientTexts);
	const appeared = difference(capture.clientTexts, capture.serverTexts);

	const tags = new Set([
		...Object.keys(capture.serverTags),
		...Object.keys(capture.clientTags),
	]);
	const drift: TagDrift[] = [];
	for (const tag of tags) {
		const server = capture.serverTags[tag] ?? 0;
		const client = capture.clientTags[tag] ?? 0;
		if (Math.abs(client - server) >= TAG_DRIFT_MIN) {
			drift.push({ tag, server, client });
		}
	}
	drift.sort(
		(a, b) => Math.abs(b.client - b.server) - Math.abs(a.client - a.server),
	);

	// The framework saying hydration failed, or server content a
	// person was sent no longer being there, is a failure. Content
	// that only appeared is a warning: a client-only widget is
	// legitimate, and this cannot tell it from a bug.
	const standing: Standing =
		warnings.length > 0 || vanished.length > 0
			? "fail"
			: appeared.length > 0 || drift.length > 0
				? "warn"
				: "pass";

	return { ...base, standing, vanished, appeared, drift, shell: false };
}

/** How many texts to name per list before counting the rest. */
const MAX_LISTED = 5;

function listed(texts: readonly string[]): string[] {
	const lines = texts.slice(0, MAX_LISTED).map((text) => `    "${text}"`);
	if (texts.length > MAX_LISTED) {
		lines.push(`    ... and ${texts.length - MAX_LISTED} more.`);
	}
	return lines;
}

/** Say whether the server render survived hydration. */
export function renderHydration(report: HydrationReport): string {
	if (!report.fetched) {
		return renderVerdict(
			{
				standing: report.standing,
				headline:
					report.warnings.length > 0
						? "The console complained about hydration, and the server " +
							"render could not be fetched to say what diverged."
						: "The server render could not be fetched, so nothing " +
							"was compared.",
				measured:
					`Fetching the page's own URL from inside it ` +
					`${report.status === undefined ? "threw" : `answered ${report.status}`}. ` +
					`The comparison needs the HTML the server sends before ` +
					`any script runs.`,
			},
			report.warnings.map((line) => `  ${line}`).join("\n"),
		);
	}

	if (report.shell) {
		return renderVerdict(
			{
				standing: report.standing,
				headline:
					"The page is client-rendered: the server sends a shell, " +
					"so there is no server render to hold the page to.",
				measured:
					"Hydration cannot mismatch when nothing is hydrated; " +
					"whether a shell is acceptable here is a judgment call, " +
					"so this is not a pass.",
			},
			report.warnings.map((line) => `  ${line}`).join("\n"),
		);
	}

	const parts: string[] = [];
	if (report.warnings.length > 0) {
		parts.push(
			`The framework complained during hydration:`,
			...report.warnings.map((line) => `    ${line}`),
		);
	}
	if (report.vanished.length > 0) {
		parts.push(
			`Server content gone after hydration ` +
				`(${count(report.vanished.length, "text")}):`,
			...listed(report.vanished),
		);
	}
	if (report.appeared.length > 0) {
		parts.push(
			`Content that only exists after hydration ` +
				`(${count(report.appeared.length, "text")}):`,
			...listed(report.appeared),
		);
	}
	if (report.drift.length > 0) {
		parts.push(
			"Element counts that moved:",
			...report.drift.map(
				(one) =>
					`    <${one.tag}>  ${one.server} on the server, ` +
					`${one.client} after hydration`,
			),
		);
	}

	const headline =
		report.standing === "pass"
			? "The hydrated page says what the server sent."
			: report.standing === "fail"
				? report.warnings.length > 0
					? "The framework itself reported a hydration failure."
					: `${count(report.vanished.length, "server text")} ` +
						`vanished during hydration.`
				: `The renders agree on shared content, but ` +
					`${count(report.appeared.length, "text")} and ` +
					`${count(report.drift.length, "tag count", "tag counts")} ` +
					`exist only after hydration.`;

	return renderVerdict(
		{
			standing: report.standing,
			headline,
			measured:
				"Compared the HTML the server sends, parsed without running " +
				"a script, against the live document. A page that renders " +
				"the time or a locale will differ between the two fetches; " +
				"paired vanished and appeared texts of the same shape are " +
				"that, not a bug.",
		},
		parts.join("\n"),
	);
}
