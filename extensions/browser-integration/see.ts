/**
 * browser_see: read the truth about a page, changing nothing.
 *
 * Kinds grow with the phases of the browser evolution plan.
 * Today the tool answers "page": the accessibility outline of
 * what is on screen, which is also the view every do call
 * returns once it has changed something.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
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
import type {
	BrowserSession,
	Inspection,
	Observation,
	Shot,
} from "../../lib/web/session.js";
import { describeRefusal, parseTarget } from "../../lib/web/target/index.js";
import {
	type NetworkRequest,
	renderLogs,
	renderRequests,
} from "../../lib/web/telemetry/index.js";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { answer, refusal } from "./result.js";

/** Lay an observation out for reading: where you are, then what is there. */
function render(observed: Observation): string {
	return `${observed.title}\n${observed.url}\n\n${observed.outline}`;
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
	const capped =
		fetched.body.length > MAX_INLINE_BODY
			? `${fetched.body.slice(0, MAX_INLINE_BODY)}\n\n[cut after ` +
				`${MAX_INLINE_BODY} of ${fetched.body.length} bytes]`
			: fetched.body;
	return `Body of ${url}:\n${capped}`;
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
export async function pageView(session: BrowserSession): Promise<string> {
	return render(await session.observe());
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
				Type.Literal("element"),
				Type.Literal("shot"),
			],
			{
				description:
					"page: the accessibility outline of what is on screen, " +
					"the default. reading: the same page narrated the way a " +
					"screen reader would say it. logs: what the page said, " +
					"threw, or had refused for it. requests: what the page " +
					"asked the network for. status: where this session stands, " +
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
			"Read a browser page with browser_see; act on it with browser_do.",
		parameters,
		async execute(_id, params) {
			const name = params.session ?? DEFAULT_SESSION;
			const kind = params.kind ?? "page";
			if (!registry.has(name)) {
				return refusal(
					name,
					kind,
					`No session '${name}'. Open one with browser_go, or navigate ` +
						`and it opens itself.`,
				);
			}
			const session = await registry.acquire(name);

			if (kind === "status") {
				return answer(name, kind, renderStatus(await session.status()));
			}

			if (kind === "requests") {
				const all = session.requests();
				const filter = params.filter;
				const wanted = filter
					? all.filter((request) => matchesFilter(request, filter))
					: all;
				const listing = renderRequests(wanted);
				if (params.har) {
					const path = await session.exportHar(wanted);
					return answer(
						name,
						kind,
						`${listing}\n\nWrote ${wanted.length} of these to an ` +
							`HTTP Archive, bodies included where Chrome still had ` +
							`them:\n  ${path}`,
					);
				}
				if (!params.body) return answer(name, kind, listing);

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
					`${listing}\n\n${renderBody(target, fetched)}`,
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
				return answer(name, kind, renderLogs(wanted));
			}

			if (kind === "announcements") {
				const { entries, cursor, dropped } = await session.heard(
					params.since ?? 0,
				);
				return answer(
					name,
					kind,
					`${renderAnnouncements(entries, dropped)}\n\ncursor: ${cursor}`,
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

			const form = kind === "reading" ? "reading" : "outline";
			if (params.within === undefined) {
				return answer(name, kind, render(await session.observe(scope, form)));
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
			return answer(name, kind, render(result.observation));
		},
	});
}
