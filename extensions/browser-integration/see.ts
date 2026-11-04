/**
 * browser_see: read the truth about a page, changing nothing.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool answers "page": the accessibility outline of
 * what is on screen, which is also the view every do call
 * returns once it has changed something. Registered from
 * see-tool.ts, which loads this on the tool's first call.
 */

import {
	ACTION_VIEW_BUDGET_BYTES,
	outlineBudget,
	renderAnnouncements,
	renderFocus,
	type Skeleton,
	type TreeScope,
} from "../../lib/core/web/a11y/index.ts";
import {
	type PseudoState,
	renderAnimations,
	renderBox,
	renderHover,
	renderListeners,
	renderMeasurement,
	renderStyles,
	renderTrace,
	renderVariants,
	renderVisibility,
} from "../../lib/core/web/element/index.ts";
import { renderStatus } from "../../lib/core/web/environment/index.ts";
import {
	measure,
	renderHeap,
	renderHotspots,
	renderLayers,
	renderVitals,
} from "../../lib/core/web/perf/index.ts";
import type {
	BrowserSession,
	Inspection,
	Observation,
	Shot,
} from "../../lib/core/web/session.ts";
import {
	describeNode,
	describeStyles,
	find,
	type IndexedNode,
	isElement,
	type Query,
	tally,
} from "../../lib/core/web/snapshot/index.ts";
import {
	describeRefusal,
	parseTarget,
} from "../../lib/core/web/target/index.ts";
import {
	anyUrlShortened,
	type NetworkRequest,
	renderDownloads,
	renderLogs,
	renderRequests,
	renderSockets,
	strandedByCrash,
} from "../../lib/core/web/telemetry/index.ts";
import { count } from "../../lib/ui/count.ts";
import { beyondBound, MAX_PROFILE_MS } from "./limits.ts";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.ts";
import {
	answer,
	chooseSession,
	missingSession,
	refusal,
	sessionInPlay,
} from "./result.ts";
import type { SeeParams } from "./see-tool.ts";
import { bodyAnswer, elementAnswer, listAnswer, pageAnswer } from "./stored.ts";

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
	// What it says and holds comes before where it is, because a
	// caller checking a counter or a filled field is asking about
	// the words, and having to scroll past a box model to reach
	// them is the wrong order.
	if (found.text) sections.push("", `Text: ${found.text}`);
	if (found.value !== undefined) sections.push(`Value: ${found.value}`);
	if (found.attributes) {
		sections.push(
			"",
			"Attributes:",
			...Object.entries(found.attributes).map(
				([named, held]) => `  ${named}="${held}"`,
			),
		);
	}
	if (found.fonts) {
		sections.push(
			"",
			"Painted with:",
			...found.fonts.map((font) => `  ${font.family} (${font.glyphs} glyphs)`),
		);
	}
	if (found.box) sections.push("", renderBox(found.box));
	if (found.styles) sections.push("", renderStyles(found.styles));
	if (found.variants) sections.push("", renderVariants(found.variants));
	if (found.listeners)
		sections.push("", renderListeners(found.listeners, found.delegated));
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
	const view = render(await session.observe(), budget);
	// A crash replaces the tab with a blank one and nothing sends
	// it back where it was, so every read after it describes
	// about:blank. Measured: crashing a tab on example.com and
	// asking for the page returned the url and nothing else, which
	// reads as a page with nothing on it rather than a page that
	// is gone. Said here because this is what every tool that
	// shows an outline goes through.
	if (!strandedByCrash(session.history)) return view;
	return (
		`${view}\n\nThe tab crashed and was replaced, and the fresh ` +
		"one has not been sent anywhere, so this is a blank page " +
		"rather than an empty one. Navigate again to get back to " +
		"where you were."
	);
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

/** What browser_see does with one call. */
export async function runSee(
	registry: SessionRegistry,
	params: SeeParams,
	signal: AbortSignal | undefined,
) {
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
	const unbounded = beyondBound(
		"ms",
		params.ms,
		MAX_PROFILE_MS,
		"Record while doing the slow thing once; a longer profile only adds idle.",
	);
	if (unbounded) return refusal(name, kind, unbounded);
	return registry.use(name, signal, async () => {
		const session = await registry.acquire(name);

		if (kind === "vitals") {
			const vitals = await session.vitals();
			return answer(name, kind, renderVitals(vitals, measure(vitals)));
		}

		if (kind === "query") {
			// Naming properties is what makes this a sweep: the snapshot
			// computes whichever ones it is given, and the caller was
			// otherwise stuck with the curated set.
			const nodes = await session.snapshot(params.styles);
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
				params.styles,
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

		if (kind === "profile") {
			return answer(
				name,
				kind,
				renderHotspots(await session.profile(params.ms ?? 3_000)),
			);
		}

		if (kind === "layers") {
			return answer(name, kind, renderLayers(await session.layers()));
		}

		if (kind === "hover") {
			return answer(
				name,
				kind,
				renderHover(await session.hovers(params.limit)),
			);
		}

		if (kind === "heap") {
			return answer(
				name,
				kind,
				renderHeap(await session.heap(params.collect ?? true)),
			);
		}

		if (kind === "sockets") {
			const open = session.sockets();
			const dropped = session.socketFramesDropped;
			return answer(
				name,
				kind,
				listAnswer({
					view:
						renderSockets(open) +
						// A chatty socket outruns any buffer, and a reader
						// drawing conclusions from frame one needs to know
						// frame zero is missing.
						(dropped > 0
							? `\n\n${dropped} earlier socket events were dropped to stay within the buffer.`
							: ""),
					records: open,
					unit: "sockets",
					narrowing:
						"Query the handle for whole frames, e.g. " +
						"$.sockets[0].frames[*].payload.",
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
						"Narrow with 'filter' by type, state, status or url " + "fragment.",
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

		if (kind === "focus") {
			// Small enough to answer whole, so nothing is stored.
			return answer(name, kind, renderFocus(await session.focusHolder()));
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
				...(params.fullPage === undefined ? {} : { fullPage: params.fullPage }),
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

		if (kind === "measure") {
			const first = parseTarget(params.within ?? "");
			const second = parseTarget(params.and ?? "");
			if (!first || !second) {
				return refusal(
					name,
					kind,
					"Name both elements, as 'role name': the first in " +
						"'within' and the second in 'and', e.g. within " +
						"'button Save' and 'button Cancel'.",
				);
			}
			const measured = await session.measure(first, second);
			if (!measured.ok) {
				return refusal(
					name,
					kind,
					"problem" in measured
						? measured.problem
						: describeRefusal(measured.target, measured.refusal),
				);
			}
			return answer(
				name,
				kind,
				renderMeasurement(
					measured.measurement,
					`${first.role} ${first.name}`,
					`${second.role} ${second.name}`,
				),
			);
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
			return answer(
				name,
				kind,
				elementAnswer(found.inspection, renderInspection(found.inspection)),
			);
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
	styles?: readonly string[],
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
			`${nodes.length} nodes across ${count(frames.size, "document")}.`,
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
		...shown.flatMap((node) => {
			const line = `  ${describeNode(node)}`;
			const said = styles === undefined ? "" : describeStyles(node, styles);
			return said ? [line, `      ${said}`] : [line];
		}),
	];
	if (found.length > shown.length) {
		lines.push("", `Showing ${shown.length}. Raise limit to see the rest.`);
	}
	return { view: lines.join("\n"), matches: found };
}
