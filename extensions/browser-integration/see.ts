/**
 * browser_see: read the truth about a page, changing nothing.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool answers "page": the accessibility outline of
 * what is on screen, which is also the view every do call
 * returns once it has changed something.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	ACTION_VIEW_BUDGET_BYTES,
	MAX_OUTLINE_BUDGET_BYTES,
	OUTLINE_BUDGET_BYTES,
	outlineBudget,
	renderAnnouncements,
	type Skeleton,
	type TreeScope,
} from "../../lib/web/a11y/index.js";
import {
	type PseudoState,
	renderAnimations,
	renderBox,
	renderListeners,
	renderStyles,
	renderTrace,
	renderVariants,
	renderVisibility,
} from "../../lib/web/element/index.js";
import { renderStatus } from "../../lib/web/environment/index.js";
import { measure, renderVitals } from "../../lib/web/perf/index.js";
import type {
	BrowserSession,
	Inspection,
	Observation,
	Shot,
} from "../../lib/web/session.js";
import {
	describeNode,
	find,
	type IndexedNode,
	isElement,
	type Query,
	tally,
} from "../../lib/web/snapshot/index.js";
import { describeRefusal, parseTarget } from "../../lib/web/target/index.js";
import {
	anyUrlShortened,
	type NetworkRequest,
	renderDownloads,
	renderLogs,
	renderRequests,
} from "../../lib/web/telemetry/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { renderBrowserCall, renderBrowserResult } from "./render.js";
import {
	answer,
	chooseSession,
	missingSession,
	refusal,
	sessionInPlay,
} from "./result.js";
import { bodyAnswer, listAnswer, pageAnswer } from "./stored.js";

/**
 * Lay an observation out for reading: where you are, then what is
 * there, bounded, with the whole tree stored when it did not fit.
 */
function render(observed: Observation, budget: number): string {
	return pageAnswer(observed, budget);
}

/**
 * Whether a request answers to what the reader asked for.
 *
 * One filter over the fields worth filtering by, so "only" can
 * be a resource type, a state, a status or a fragment of url
 * without the caller having to say which it meant.
 */
function matchesFilter(request: NetworkRequest, only: string): boolean {
	const needle = only.toLowerCase();
	return (
		request.resourceType.toLowerCase() === needle ||
		request.state === needle ||
		String(request.status ?? "") === needle ||
		(needle === "failed" && request.state === "failed") ||
		(needle === "errors" &&
			(request.state === "failed" ||
				(request.status ?? 0) >= FIRST_ERROR_STATUS)) ||
		request.url.toLowerCase().includes(needle)
	);
}

/** Where a status stops being a success. */
const FIRST_ERROR_STATUS = 400;

/**
 * The request a reader meant, by the number shown against it.
 *
 * The protocol's own id is accepted too, since it is what a
 * caller holding an earlier capture would have.
 */
function pick(
	requests: readonly NetworkRequest[],
	choice: string,
): NetworkRequest | undefined {
	const ordinal = Number(choice.replace(/^#/, ""));
	if (Number.isInteger(ordinal) && ordinal >= 1) {
		return requests[ordinal - 1];
	}
	return requests.find((request) => request.id === choice);
}

/** How much of a body reads inline before it crowds the answer out. */
const MAX_INLINE_BODY = 16384;

/** A fetched body, capped, with the cap declared. */
function renderBody(
	request: NetworkRequest,
	fetched: { body: string; base64Encoded: boolean } | undefined,
): string {
	const url = request.url;
	if (!fetched) {
		return (
			`No body is available for ${url}. Chrome discards bodies on ` +
			`navigation, and a request that failed never had one.`
		);
	}

	// An empty body against a request that plainly transferred
	// something means Chrome did not keep it, which is a different
	// fact from the resource being empty, and the one worth saying.
	if (fetched.body.length === 0 && (request.transferredBytes ?? 0) > 0) {
		return (
			`Chrome kept no body for ${url}, though ` +
			`${request.transferredBytes} bytes were transferred. It ` +
			`releases bodies it no longer needs, images especially.`
		);
	}
	if (fetched.base64Encoded) {
		const bytes = Buffer.from(fetched.body, "base64").length;
		return `Body of ${url}: ${bytes} bytes of binary, not shown.`;
	}
	if (fetched.body.length <= MAX_INLINE_BODY) {
		return `Body of ${url}:\n${fetched.body}`;
	}
	// Cut and kept, rather than cut and announced. This said how many
	// bytes it had thrown away and gave no way to ask for them, which
	// is the thing the rest of this change exists to stop doing.
	// Bytes, not lines: a response body is content rather than a
	// rendering, and a minified one is a single line the length of
	// the file.
	return bodyAnswer(url, fetched.body, MAX_INLINE_BODY);
}

/**
 * Where the pictures went.
 *
 * Images are never returned inline: one screenshot is larger
 * than the whole response budget and would crowd out the
 * reading it was meant to illustrate.
 */
function renderShot(shot: Shot): string {
	const size =
		shot.width > 0 && shot.height > 0
			? ` (${shot.width} by ${shot.height})`
			: "";
	const lines = [
		shot.paths.length === 1
			? `Wrote one image${size}:`
			: `Wrote ${shot.paths.length} images, top to bottom:`,
		...shot.paths.map((path) => `  ${path}`),
	];
	if (shot.truncated) {
		lines.push(
			"",
			"The page ran past the tile budget, so its foot is missing.",
		);
	}
	return lines.join("\n");
}

/**
 * One element, in the order the questions get asked: what it
 * is, whether it can be seen, where it sits, how it is styled
 * and why.
 */
function renderInspection(found: Inspection): string {
	const sections = [
		`${found.node.role} ${found.node.name}`.trim(),
		"",
		renderVisibility(found.visibility),
	];
	if (found.box) sections.push("", renderBox(found.box));
	if (found.styles) sections.push("", renderStyles(found.styles));
	if (found.variants) sections.push("", renderVariants(found.variants));
	if (found.listeners) sections.push("", renderListeners(found.listeners));
	if (found.animations) sections.push("", renderAnimations(found.animations));
	if (found.trace) sections.push("", renderTrace(found.trace));
	return sections.join("\n");
}

/**
 * The page as the caller should read it: where they are, then
 * the accessibility outline of what is there.
 */
export async function pageView(
	session: BrowserSession,
	budget: number = ACTION_VIEW_BUDGET_BYTES,
): Promise<string> {
	return render(await session.observe(), budget);
}

/**
 * The page after whatever just happened to it has finished
 * happening.
 *
 * Every tool that changes the page answers with a fresh outline,
 * and on a client-rendered app that outline used to describe the
 * page as it was before the change landed: pressing Enter on a
 * search box returned the pre-search page, and the caller then
 * reasoned confidently about a page that no longer existed.
 *
 * A page that never stops changing says so rather than being
 * waited on for ever, because a reading of a moving page is worth
 * having as long as nobody is told it was final.
 */
export async function settledPageView(
	session: BrowserSession,
): Promise<string> {
	const settled = await session.settlePage();
	const view = await pageView(session);
	return settled.quiet
		? view
		: `${view}

Still changing after ${settled.waitedMs}ms ` +
				`(${settled.mutations} DOM changes while waiting), so this is a ` +
				"snapshot of a page in motion rather than where it ended up.";
}

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("page"),
				Type.Literal("reading"),
				Type.Literal("announcements"),
				Type.Literal("logs"),
				Type.Literal("requests"),
				Type.Literal("status"),
				Type.Literal("downloads"),
				Type.Literal("query"),
				Type.Literal("vitals"),
				Type.Literal("element"),
				Type.Literal("shot"),
			],
			{
				description:
					"page: the accessibility outline of what is on screen, " +
					"the default. reading: the same page narrated the way a " +
					"screen reader would say it. logs: what the page said, " +
					"threw, or had refused for it. requests: what the page " +
					"asked the network for. vitals: what the page cost to " +
					"show, from the browser's own performance observers. " +
					"query: search the whole page, " +
					"frames and shadow content included, for nodes matching " +
					"a tag, attribute, class or text. downloads: files the " +
					"page handed " +
					"back. status: where this session stands, " +
					"including what it is pretending to be. announcements: " +
					"what the page " +
					"said out loud through its live regions. element: " +
					"everything about one element, named with 'within'. " +
					"shot: a picture, written to disk and reported by path.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	within: Type.Optional(
		Type.String({
			description:
				"Read only the branch under this element, named as " +
				"'role name', e.g. 'navigation Main' or 'form Checkout'. " +
				"For kind 'element', the element to inspect.",
		}),
	),
	styles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For element: report exactly these CSS properties instead " +
				"of the curated set.",
		}),
	),
	why: Type.Optional(
		Type.String({
			description:
				"For element: trace why this one CSS property has the " +
				"value it has, through every rule that had a say.",
		}),
	),
	fullPage: Type.Optional(
		Type.Boolean({
			description:
				"For shot: capture the whole scrollable page rather than " +
				"what is on screen. Long pages come back as several tiles.",
		}),
	),
	state: Type.Optional(
		Type.Union(
			[
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("active"),
				Type.Literal("focus-visible"),
			],
			{
				description:
					"For shot: hold this state on the element while " +
					"capturing, so a hover or focus style can be seen.",
			},
		),
	),
	behaviour: Type.Optional(
		Type.Boolean({
			description:
				"For element: also report what is listening on it and " +
				"what is animating, which answers why a click did nothing.",
		}),
	),
	states: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("active"),
				Type.Literal("focus-visible"),
			]),
			{
				description:
					"For element: hold each of these states and report what " +
					"changes, which is how to check a focus ring exists.",
			},
		),
	),
	depth: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Keep this many levels of the outline. Omit for all of it.",
		}),
	),
	har: Type.Optional(
		Type.Boolean({
			description:
				"For requests: also write the listing to disk as an HTTP " +
				"Archive, which any network tool can open.",
		}),
	),
	filter: Type.Optional(
		Type.String({
			description:
				"For requests: keep only those matching, by resource type " +
				"(script, image, fetch), by state (failed, pending), by " +
				"status, by the word 'errors', or by part of the url.",
		}),
	),
	body: Type.Optional(
		Type.String({
			description:
				"For requests: also fetch the body of one request, named " +
				"by the number shown against it (#3, or just 3). Bodies " +
				"are not held as they stream past, so this asks now.",
		}),
	),
	level: Type.Optional(
		Type.String({
			description:
				"For logs: keep only this level, in the browser's own " +
				"vocabulary (error, warning, info, log, debug).",
		}),
	),
	since: Type.Optional(
		Type.Integer({
			minimum: 0,
			description:
				"For logs and announcements: read only what arrived after " +
				"this " +
				"cursor, which the previous read returned.",
		}),
	),
	only: Type.Optional(
		Type.Union(
			[
				Type.Literal("landmarks"),
				Type.Literal("headings"),
				Type.Literal("interactive"),
			],
			{
				description:
					"Reduce the page to one kind of thing: 'landmarks' for " +
					"how it is laid out, 'headings' for its outline, " +
					"'interactive' for what you can operate.",
			},
		),
	),
	tag: Type.Optional(
		Type.String({ description: "For query: the tag name to look for." }),
	),
	attribute: Type.Optional(
		Type.String({
			description:
				"For query: an attribute that must be present, e.g. " +
				"'data-testid'. Pair with value to require a value too.",
		}),
	),
	value: Type.Optional(
		Type.String({ description: "For query: the attribute's value." }),
	),
	className: Type.Optional(
		Type.String({ description: "For query: a class the node carries." }),
	),
	text: Type.Optional(
		Type.String({
			description: "For query: text the node must contain.",
		}),
	),
	rendered: Type.Optional(
		Type.Boolean({
			description:
				"For query: true for only what the browser drew, false for " +
				"only what it did not, which is how you find out why " +
				"something is missing.",
		}),
	),
	inShadow: Type.Optional(
		Type.Boolean({
			description: "For query: restrict to content inside shadow roots.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"For query: how many matches to list. The total is always " +
				"reported, however many are shown.",
		}),
	),
	budget: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_OUTLINE_BUDGET_BYTES,
			description:
				"For page and reading: how many bytes of outline to return " +
				`before storing the rest. Defaults to ${OUTLINE_BUDGET_BYTES}, ` +
				`and will not go above ${MAX_OUTLINE_BUDGET_BYTES}. Whatever ` +
				"is cut stays queryable by handle, so narrowing with 'only', " +
				"'depth' or 'within' is the way to see more, not raising this.",
		}),
	),
});

/** Register the reading half of the browser family. */
export function registerSee(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_see",
		label: "Browser See",
		description:
			"Read the current state of a browser session without changing it. " +
			"kind 'page' (the default) returns the page's accessibility outline: " +
			"the roles and names of everything on screen, which is how you name " +
			"elements when you act on them. kind 'reading' narrates the same " +
			"page as a screen reader would, which is how you review what the " +
			"experience is like without sight. On a large page, narrow it: " +
			"'only' reduces to landmarks, headings or interactive elements, " +
			"'depth' keeps the top levels, and 'within' reads one branch.",
		promptSnippet:
			"browser_see reads a page and changes nothing: its " +
			"accessibility outline, reading order, one element in " +
			"depth, a query across frames and shadow roots, console " +
			"and network telemetry, screenshots, vitals, status. Read " +
			"the browser-guide skill.",
		parameters,
		renderCall: (args, theme) => renderBrowserCall("see", args, theme),
		renderResult: (result, options, theme) =>
			renderBrowserResult(result, options, theme),
		async execute(_id, params) {
			const kind = params.kind ?? "page";
			const chosen = sessionInPlay(
				params.session,
				DEFAULT_SESSION,
				registry.open(),
			);
			if ("candidates" in chosen) {
				return refusal(DEFAULT_SESSION, kind, chooseSession(chosen.candidates));
			}
			const name = chosen.name;
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					missingSession(
						name,
						registry.departureOf(name),
						"Open one with browser_go, or navigate and it opens itself.",
					),
				);
			}
			const session = await registry.acquire(name);

			if (kind === "vitals") {
				const vitals = await session.vitals();
				return answer(name, kind, renderVitals(vitals, measure(vitals)));
			}

			if (kind === "query") {
				const nodes = await session.snapshot();
				const queried = runQuery(
					nodes,
					{
						...(params.tag === undefined ? {} : { tag: params.tag }),
						...(params.attribute === undefined
							? {}
							: { attribute: params.attribute }),
						...(params.value === undefined ? {} : { value: params.value }),
						...(params.className === undefined
							? {}
							: { className: params.className }),
						...(params.text === undefined ? {} : { text: params.text }),
						...(params.rendered === undefined
							? {}
							: { rendered: params.rendered }),
						...(params.inShadow === undefined
							? {}
							: { inShadow: params.inShadow }),
					},
					params.limit,
				);
				// The matches themselves go to the store, so the ones past
				// the cap are a query away rather than a re-run away.
				return answer(
					name,
					kind,
					queried.matches === undefined
						? queried.view
						: listAnswer({
								view: queried.view,
								records: queried.matches,
								unit: "matching nodes",
								narrowing:
									"Narrow with tag, attribute, className, text, rendered " +
									"or inShadow, or raise 'limit'.",
							}),
				);
			}

			if (kind === "downloads") {
				const files = session.downloads();
				return answer(
					name,
					kind,
					listAnswer({
						view: renderDownloads(files),
						records: files,
						unit: "downloads",
						narrowing: "Every file is on disk at the path shown.",
					}),
				);
			}

			if (kind === "status") {
				return answer(name, kind, renderStatus(await session.status()));
			}

			if (kind === "requests") {
				const all = session.requests();
				const filter = params.filter;
				const wanted = filter
					? all.filter((request) => matchesFilter(request, filter))
					: all;
				const listing = renderRequests(wanted, {
					...(filter === undefined ? {} : { filter }),
					recorded: all.length,
				});
				// Both of the paths below bound the same listing the plain
				// one does. They used to hand it back whole, so asking for
				// an archive or a body was a way to opt out of the bounding
				// by asking for more.
				if (params.har) {
					const path = await session.exportHar(wanted);
					return answer(
						name,
						kind,
						listAnswer({
							view: listing,
							elided: anyUrlShortened(wanted),
							// Where the archive went is the whole point of the
							// call, so it cannot be what the budget removes.
							trailer:
								`Wrote ${wanted.length} of these to an HTTP Archive, ` +
								`bodies included where Chrome still had them:\n  ${path}`,
							records: wanted,
							unit: "requests",
							narrowing:
								"Narrow with 'filter' by type, state, status or url " +
								"fragment. The archive on disk holds them all either " +
								"way.",
						}),
					);
				}
				if (!params.body)
					return answer(
						name,
						kind,
						listAnswer({
							view: listing,
							// A url too long to scan is shortened in the middle,
							// which is a cut the line budget cannot see. Without
							// this, a page of three requests and one enormous url
							// fitted, cited nothing, and lost the middle of it.
							elided: anyUrlShortened(wanted),
							records: wanted,
							unit: "requests",
							narrowing:
								"Narrow with 'filter' by type, state, status or url " +
								"fragment, or write the archive to disk with 'har'.",
						}),
					);

				const target = pick(wanted, params.body);
				if (!target) {
					return refusal(
						name,
						kind,
						`No request '${params.body}' in this listing. Ask by the ` +
							`number shown against it, from #1 to #${wanted.length}.`,
					);
				}
				const fetched = await session.bodyOf(target.id);
				return answer(
					name,
					kind,
					listAnswer({
						view: listing,
						elided: anyUrlShortened(wanted),
						// The body is what was asked for by name, so it survives
						// the cut to the listing around it. It bounds itself,
						// and cites its own handle when it has to.
						trailer: renderBody(target, fetched),
						records: wanted,
						unit: "requests",
						narrowing:
							"Narrow with 'filter' by type, state, status or url " +
							"fragment.",
					}),
				);
			}

			if (kind === "logs") {
				const captured = session.logs(params.since);
				const wanted = params.level
					? {
							...captured,
							entries: captured.entries.filter(
								({ item }) => item.level === params.level,
							),
						}
					: captured;
				return answer(
					name,
					kind,
					listAnswer({
						view: renderLogs(wanted),
						records: wanted.entries.map(({ item }) => item),
						unit: "log entries",
						narrowing:
							"Narrow with 'level' to one severity, or with 'since' to " +
							"what arrived after a cursor.",
					}),
				);
			}

			if (kind === "announcements") {
				const { entries, cursor, dropped } = await session.heard(
					params.since ?? 0,
				);
				return answer(
					name,
					kind,
					listAnswer({
						view: renderAnnouncements(entries, dropped),
						// The cursor is how the next call continues, so it has
						// to outlive the cut. Written into the view, it sat on
						// the last line and went first: a page noisy enough to
						// need bounding is exactly the page somebody is polling.
						trailer: `cursor: ${cursor}`,
						records: entries.map(({ item }) => item),
						unit: "announcements",
						narrowing:
							"Read from a cursor with 'since' to hear only what is new.",
					}),
				);
			}

			if (kind === "shot") {
				const target = parseTarget(params.within ?? "");
				const taken = await session.shoot({
					...(target === undefined ? {} : { target }),
					...(params.fullPage === undefined
						? {}
						: { fullPage: params.fullPage }),
					...(params.state === undefined
						? {}
						: { state: params.state as PseudoState }),
				});
				if (!taken.ok) {
					return refusal(
						name,
						kind,
						describeRefusal(target ?? { role: "", name: "" }, taken.refusal),
					);
				}
				return answer(name, kind, renderShot(taken.shot));
			}

			if (kind === "element") {
				const target = parseTarget(params.within ?? "");
				if (!target) {
					return refusal(
						name,
						kind,
						"Name the element to inspect in 'within', as 'role name', " +
							"e.g. 'button Save'. browser_see kind \"page\" lists what " +
							"is there.",
					);
				}
				const found = await session.inspect(target, {
					...(params.styles === undefined ? {} : { styles: params.styles }),
					...(params.why === undefined ? {} : { why: params.why }),
					...(params.behaviour === undefined
						? {}
						: { behaviour: params.behaviour }),
					...(params.states === undefined
						? {}
						: { states: params.states as PseudoState[] }),
				});
				if (!found.ok) {
					return refusal(name, kind, describeRefusal(target, found.refusal));
				}
				return answer(name, kind, renderInspection(found.inspection));
			}

			const scope: TreeScope = {
				...(params.depth === undefined ? {} : { depth: params.depth }),
				...(params.only === undefined ? {} : { only: params.only as Skeleton }),
			};

			// A caller who asked to see the page gets the generous budget;
			// the tighter one is for the view that follows an action nobody
			// asked a page read of.
			// Clamped, not obeyed. Raising this is never how you see
			// more of a page: whatever is cut stays queryable, so a
			// hundred-megabyte budget buys nothing the handle does not
			// already offer, and spends a context window doing it.
			const budget = outlineBudget(params.budget);
			const form = kind === "reading" ? "reading" : "outline";
			if (params.within === undefined) {
				return answer(
					name,
					kind,
					render(await session.observe(scope, form), budget),
				);
			}

			const target = parseTarget(params.within);
			if (!target) {
				return refusal(
					name,
					kind,
					`Could not read '${params.within}' as an element. Name it as ` +
						`'role name', e.g. 'navigation Main', or as a role on its ` +
						`own, e.g. 'main'.`,
				);
			}
			const result = await session.observeWithin(target, scope, form);
			if (!result.ok) {
				return refusal(name, kind, describeRefusal(target, result.refusal));
			}
			return answer(name, kind, render(result.observation, budget));
		},
	});
}

/** How many matches to list before summarising instead. */
const DEFAULT_QUERY_LIMIT = 25;

/** A query's answer, and the matches behind it when it found any. */
interface QueryReport {
	readonly view: string;
	/** Absent when the answer was a summary rather than a match list. */
	readonly matches?: readonly IndexedNode[];
}

/**
 * Run a query and report it.
 *
 * The total always comes first and is always the real total. A
 * listing that quietly shows the first twenty-five of four
 * hundred is how somebody concludes there are twenty-five.
 */
function runQuery(
	nodes: readonly IndexedNode[],
	query: Query,
	limit?: number,
): QueryReport {
	const asked = Object.keys(query).length > 0;
	if (!asked) {
		// With no query the useful answer is the shape of the page,
		// not every node in it.
		const byTag = tally(nodes.filter(isElement), (node) =>
			node.nodeName.toLowerCase(),
		);
		const frames = new Set(nodes.map((node) => node.documentUrl));
		const shape = [
			`${nodes.length} nodes across ${frames.size} document` +
				`${frames.size === 1 ? "" : "s"}.`,
			`${nodes.filter((node) => !node.rendered).length} were not rendered, ` +
				`${nodes.filter((node) => node.inShadow).length} are inside ` +
				"shadow roots.",
			"",
			"Most common elements:",
			...byTag
				.slice(0, DEFAULT_QUERY_LIMIT)
				.map(
					(entry) => `  ${entry.count.toString().padStart(4)}  ${entry.key}`,
				),
			"",
			"Narrow it with tag, attribute, className, text, rendered " +
				"or inShadow.",
		].join("\n");
		return { view: shape };
	}

	const found = find(nodes, query);
	if (found.length === 0) {
		return {
			view: "Nothing on the page matches that, in any frame or shadow root.",
		};
	}

	const cap = limit ?? DEFAULT_QUERY_LIMIT;
	const shown = found.slice(0, cap);
	const lines = [
		`${found.length} match${found.length === 1 ? "" : "es"}.`,
		"",
		...shown.map((node) => `  ${describeNode(node)}`),
	];
	if (found.length > shown.length) {
		lines.push("", `Showing ${shown.length}. Raise limit to see the rest.`);
	}
	return { view: lines.join("\n"), matches: found };
}
