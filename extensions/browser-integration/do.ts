/**
 * browser_do: change the page.
 *
 * Five kinds, in decreasing order of how much they know about
 * the page. act names an element the way it reads in the
 * outline. press sends keys wherever focus already is. input
 * sends raw gestures at coordinates, which is the only way to
 * reach a drag, a wheel or a swipe. wait holds until the page
 * reaches a state it gets to on its own. eval runs an
 * expression and describes what came back.
 *
 * The three that change the page answer with a fresh page view,
 * so the caller sees the result of what it just did. wait and
 * eval answer with what they were asked for.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { renderEvaluation } from "@jitsusama/agentic-harness.core/web/evaluate";
import {
	composeClick,
	composeDrag,
	composeLongPress,
	composePinch,
	composeSwipe,
	composeTap,
	LONG_PRESS_MS,
	type MouseButton,
} from "@jitsusama/agentic-harness.core/web/input";
import {
	renderTrace,
	type TraceCapture,
	type TraceProfile,
} from "@jitsusama/agentic-harness.core/web/perf";
import type {
	BrowserSession,
	TargetedAction,
} from "@jitsusama/agentic-harness.core/web/session";
import {
	describeRefusal,
	describeTarget,
	type Target,
} from "@jitsusama/agentic-harness.core/web/target";
import {
	DEFAULT_QUIET_MS,
	renderWait,
	type WaitCondition,
} from "@jitsusama/agentic-harness.core/web/wait";
import { Type } from "@sinclair/typebox";
import { DEFAULT_SESSION, type SessionRegistry } from "./registry.js";
import { renderBrowserCall, renderBrowserResult } from "./render.js";
import type { BrowserDetails } from "./result.js";
import {
	answer,
	chooseSession,
	missingSession,
	refusal,
	sessionInPlay,
} from "./result.js";
import { settledPageView } from "./see.js";

const parameters = Type.Object({
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("act"),
				Type.Literal("press"),
				Type.Literal("input"),
				Type.Literal("wait"),
				Type.Literal("eval"),
			],
			{
				description:
					"act: operate an element named by role and accessible " +
					"name, the default. press: send a chord or a sequence of " +
					"them, like 'Ctrl+Shift+K' or 'Tab Tab Enter', wherever " +
					"focus is. input: raw pointer and touch gestures at " +
					"coordinates, for what semantics cannot reach. wait: hold " +
					"until the page reaches a state, saying what it saw if it " +
					"never does. eval: run an expression in the page and " +
					"describe what came back, exceptions included.",
			},
		),
	),
	session: Type.Optional(
		Type.String({ description: "Session name. Defaults to 'default'." }),
	),
	expression: Type.Optional(
		Type.String({
			description:
				"For eval: the JavaScript to run, as an expression rather " +
				"than statements. A promise is awaited. DOM nodes, " +
				"functions and circular structures are described rather " +
				"than serialized.",
		}),
	),
	for: Type.Optional(
		Type.Union(
			[
				Type.Literal("selector"),
				Type.Literal("gone"),
				Type.Literal("text"),
				Type.Literal("attribute"),
				Type.Literal("count"),
				Type.Literal("idle"),
				Type.Literal("request"),
				Type.Literal("animations"),
				Type.Literal("duration"),
			],
			{
				description:
					"For wait: selector or gone for an element appearing or " +
					"leaving, text for words on the page, idle for the " +
					"network going quiet, request for one matching a pattern " +
					"finishing, attribute for an element's attribute reaching " +
					"a value (aria-busy going false, aria-expanded going " +
					"true), count for a number of matching elements being " +
					"there, animations for motion settling, duration to " +
					"simply pass time.",
			},
		),
	),
	selector: Type.Optional(
		Type.String({
			description:
				"For wait selector, gone, attribute and count: the CSS " + "selector.",
		}),
	),
	attribute: Type.Optional(
		Type.String({
			description:
				"For wait attribute: which attribute to watch, e.g. " +
				"'aria-busy'. Pair with 'value' for the value to wait for, " +
				"or omit it to wait for the attribute to be removed.",
		}),
	),
	value: Type.Optional(
		Type.String({
			description:
				"For wait attribute: the value that ends the wait. Omit to " +
				"wait for the attribute to go away entirely.",
		}),
	),
	count: Type.Optional(
		Type.Number({
			description:
				"For wait count: how many elements must match the " +
				"selector. Exact, not a minimum, so a list that overshoots " +
				"is a finding rather than a pass. For input click: 2 " +
				"double-clicks.",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description:
				"For wait request: a url pattern, e.g. '*/api/save'. The " +
				"answer reports the status it got.",
		}),
	),
	status: Type.Optional(
		Type.Number({
			description:
				"For wait request: the status that counts as arrival. " +
				"Without it a request answering 500 ends the wait as " +
				"happily as one answering 200, so a check that the save " +
				"worked passes on a save that failed.",
		}),
	),
	quietMs: Type.Optional(
		Type.Number({
			description: "For wait idle: how long counts as quiet.",
		}),
	),
	ms: Type.Optional(
		Type.Number({ description: "For wait duration: how long to wait." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "For wait: how long before giving up. Defaults to 10s.",
		}),
	),
	keys: Type.Optional(
		Type.String({
			description:
				"For press: the chord or sequence, e.g. 'Ctrl+Shift+K', " +
				"'Tab Tab Enter', 'Shift+ArrowDown'. Space is written as " +
				"the word Space.",
		}),
	),
	gesture: Type.Optional(
		Type.Union(
			[
				Type.Literal("click"),
				Type.Literal("drag"),
				Type.Literal("move"),
				Type.Literal("wheel"),
				Type.Literal("tap"),
				Type.Literal("longPress"),
				Type.Literal("swipe"),
				Type.Literal("pinch"),
			],
			{
				description:
					"For input: which gesture. click, drag, move and wheel " +
					"use the mouse; tap, longPress, swipe and pinch use " +
					"touch. All take coordinates in x/y, and the travelling " +
					"ones take toX/toY.",
			},
		),
	),
	x: Type.Optional(Type.Number({ description: "For input: where it starts." })),
	y: Type.Optional(Type.Number({ description: "For input: where it starts." })),
	toX: Type.Optional(
		Type.Number({ description: "For drag, swipe and wheel: where it ends." }),
	),
	toY: Type.Optional(
		Type.Number({ description: "For drag, swipe and wheel: where it ends." }),
	),
	spread: Type.Optional(
		Type.Number({
			description: "For pinch: how far apart the fingers start, in pixels.",
		}),
	),
	toSpread: Type.Optional(
		Type.Number({
			description: "For pinch: how far apart they end. Larger zooms in.",
		}),
	),

	button: Type.Optional(
		Type.String({
			description: "For input click and drag: left, middle or right.",
		}),
	),
	steps: Type.Optional(
		Type.Number({
			description:
				"For travelling gestures: how many intermediate moves. More " +
				"steps give a handler more to react to.",
		}),
	),
	holdMs: Type.Optional(
		Type.Number({ description: "For longPress: how long to hold." }),
	),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("click"),
				Type.Literal("type"),
				Type.Literal("hover"),
				Type.Literal("focus"),
				Type.Literal("clear"),
				Type.Literal("select"),
				Type.Literal("upload"),
				Type.Literal("scrollTo"),
			],
			{
				description:
					"For act: click or type into the element; hover or focus " +
					"it to reveal state-dependent behaviour; clear empties a " +
					"field; select chooses an option by its text; upload puts " +
					"files on a file input, named in 'files'; scrollTo brings " +
					"it into view.",
			},
		),
	),
	role: Type.Optional(
		Type.String({ description: "For act: the target element's role." }),
	),
	name: Type.Optional(
		Type.String({ description: "For act: the target's accessible name." }),
	),
	text: Type.Optional(
		Type.String({
			description:
				"For action 'type': the text to enter. For 'select': the " +
				"option to choose.",
		}),
	),
	files: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"For action 'upload': absolute paths to put on the file " +
				"input. Target the input itself, which is usually hidden " +
				"behind a styled label and reads as a button in the " +
				"outline; it does not have to be visible.",
		}),
	),
	container: Type.Optional(
		Type.String({
			description:
				"For act: restrict the search to a container with this " +
				"name, which is how you tell two identically named " +
				"controls apart by where they live.",
		}),
	),
	ordinal: Type.Optional(
		Type.Number({
			description:
				"For act: 1-based position among same-named matches, for " +
				"when no container distinguishes them either.",
		}),
	),
	trace: Type.Optional(
		Type.Union(
			[
				Type.Literal("async"),
				Type.Literal("frames"),
				Type.Array(Type.Union([Type.Literal("async"), Type.Literal("frames")])),
			],
			{
				description:
					"For every kind: record a trace of the browser's own work " +
					"while this runs, and report what caused what. 'async' " +
					"pairs each timer with the fire it caused and each request " +
					"with the response that settled it, so you can see what " +
					"was in flight at once and what answered out of order. " +
					"'frames' reports what the compositor did, for a page that " +
					"scrolls or animates badly. Pass both for both. Tracing " +
					"is browser-wide and only one can run at a time, so a " +
					"second session asking is refused, and every page pays " +
					"while it runs.",
			},
		),
	),
});

/** Register the acting half of the browser family. */
export function registerDo(pi: ExtensionAPI, registry: SessionRegistry): void {
	pi.registerTool({
		name: "browser_do",
		label: "Browser Do",
		description:
			"Act on a browser page. kind 'act' clicks an element or types into " +
			"it, targeting the element the way it reads in the outline: by role " +
			"and accessible name, narrowed by container or by the 1-based " +
			"ordinal among same-named matches. kind 'press' sends a chord " +
			"wherever focus is. kind 'input' sends raw pointer and touch " +
			"gestures at coordinates, for drags, wheels and swipes that no " +
			"semantic action expresses. The page view that follows shows what " +
			"the action did.",
		promptSnippet:
			"browser_do changes a page: act on an element named by role " +
			"and accessible name (waiting for it to be actionable), " +
			"press key chords, send raw pointer and touch gestures, " +
			"wait for a condition, or evaluate an expression. Read the " +
			"browser-guide skill.",
		parameters,
		renderCall: (args, theme, context) =>
			renderBrowserCall("do", args, theme, context?.lastComponent),
		renderResult: (result, options, theme, context) =>
			renderBrowserResult(result, options, theme, context?.lastComponent),
		async execute(_id, params) {
			const kind = params.kind ?? "act";
			const profiles = wantedProfiles(params.trace);
			if ("error" in profiles) {
				return refusal(DEFAULT_SESSION, kind, profiles.error);
			}
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
						"Navigate somewhere with browser_go first.",
					),
				);
			}

			// Every kind is traceable, because every kind is a way of
			// making the page do something. Bracketing here rather than
			// in each branch keeps one recording per call and means the
			// permit cannot be left behind on a path that returns early.
			if (profiles.profiles.length > 0) {
				const session = await registry.acquire(name);
				const recorded = await session.recordWhile(profiles.profiles, () =>
					act(),
				);
				return withTrace(recorded.result, recorded.trace, recorded.refusal);
			}
			return act();

			async function act(): Promise<AgentToolResult<BrowserDetails>> {
				if (kind === "eval") {
					if (!params.expression) {
						return refusal(
							name,
							kind,
							"eval needs an expression, e.g. 'document.title'.",
						);
					}
					const session = await registry.acquire(name);
					const outcome = await session.evaluate(params.expression);
					return answer(name, kind, renderEvaluation(outcome));
				}

				if (kind === "wait") {
					const built = buildCondition(params);
					if ("error" in built) return refusal(name, kind, built.error);
					const session = await registry.acquire(name);
					const outcome = await session.waitFor(
						built.condition,
						params.timeoutMs,
					);
					return answer(
						name,
						kind,
						`${renderWait(outcome)}\n\n${await settledPageView(session)}`,
					);
				}

				if (kind === "press") {
					if (!params.keys) {
						return refusal(name, kind, "press needs keys, e.g. 'Ctrl+Enter'.");
					}
					const session = await registry.acquire(name);
					const result = await session.press(params.keys);
					if ("refusal" in result) {
						const { message, candidates } = result.refusal;
						return refusal(
							name,
							kind,
							candidates.length > 0
								? `${message} Did you mean ${candidates.join(", ")}?`
								: message,
						);
					}
					return answer(
						name,
						kind,
						`Pressed ${result.pressed.join(", then ")}.\n\n` +
							`${await settledPageView(session)}`,
					);
				}

				if (kind === "input") {
					const session = await registry.acquire(name);
					const done = await runGesture(session, params);
					if ("error" in done) return refusal(name, kind, done.error);
					return answer(
						name,
						kind,
						`${done.did}\n\n${await settledPageView(session)}`,
					);
				}

				// A name is not required. The outline writes a control that
				// has no accessible name as its role alone, and demanding a
				// name here made every one of them unreachable except by
				// coordinates, which is the escape hatch and not the way in.
				if (!params.action || !params.role) {
					return refusal(
						name,
						kind,
						"act needs an action and a role, plus the accessible " +
							"name when the element has one. To send keys without " +
							"naming an element, use kind 'press'.",
					);
				}

				const action = buildAction({
					...params,
					action: params.action,
					role: params.role,
					name: params.name,
				});
				if (!action) {
					const needs =
						params.action === "select"
							? "the option to choose in"
							: params.action === "upload"
								? "the paths to put on"
								: "the text to enter into";
					return refusal(
						name,
						kind,
						`action '${params.action}' needs ${needs} ` +
							`${describeTarget({ role: params.role, name: params.name })}.`,
					);
				}

				const session = await registry.acquire(name);
				const result = await session.act(action);
				if (!result.ok) {
					if ("blocked" in result) {
						return refusal(
							name,
							kind,
							`Waited ${result.blocked.waitedMs}ms but ` +
								`${describeTarget({ role: params.role, name: params.name })} ` +
								`never became ready: ${result.blocked.blocker}.`,
						);
					}
					return refusal(
						name,
						kind,
						describeRefusal(action.target, result.refusal),
					);
				}
				const view = await settledPageView(session);
				// Say when the page kept the caller waiting, so a slow
				// interaction is visible rather than merely felt.
				return answer(
					name,
					kind,
					result.waitedMs
						? `Waited ${result.waitedMs}ms for it to be ready.\n\n${view}`
						: view,
				);
			}
		},
	});
}

/**
 * Which profiles the caller asked to record, if any.
 *
 * An unknown profile is refused rather than ignored: silently
 * recording nothing would answer the action and quietly drop the
 * question the caller actually asked.
 */
function wantedProfiles(
	trace: unknown,
): { profiles: readonly TraceProfile[] } | { error: string } {
	if (trace === undefined) return { profiles: [] };
	const asked = Array.isArray(trace) ? trace : [trace];
	const known: TraceProfile[] = [];
	for (const one of asked) {
		if (one === "async" || one === "frames") known.push(one);
		else {
			return {
				error:
					`There is no '${String(one)}' trace profile. Ask for ` +
					"'async' for timers, requests and script, or 'frames' for " +
					"what the compositor did, or both.",
			};
		}
	}
	return { profiles: known };
}

/**
 * Put the recording under the action's own answer.
 *
 * The action's result leads, because the caller asked for the
 * action and the trace is why they asked for it that way. A trace
 * that could not be taken is said plainly rather than left as
 * silence that reads like a page doing nothing.
 */
function withTrace(
	result: AgentToolResult<BrowserDetails>,
	trace: TraceCapture | undefined,
	traceRefusal: string | undefined,
): AgentToolResult<BrowserDetails> {
	const note =
		trace !== undefined
			? renderTrace(trace)
			: (traceRefusal ?? "The trace could not be recorded.");
	const existing = result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	return {
		...result,
		content: [{ type: "text", text: `${existing}\n\n${note}` }],
	};
}

/** Turn the tool's flat parameters into a wait condition. */
function buildCondition(params: {
	for?: string;
	selector?: string;
	text?: string;
	pattern?: string;
	quietMs?: number;
	ms?: number;
	attribute?: string;
	value?: string;
	count?: number;
	status?: number;
}): { condition: WaitCondition } | { error: string } {
	// Zero ceremony, the same rule the rest of this family follows:
	// when the arguments already say what is meant, naming the kind
	// as well is a toll. `ms: 500` is a duration and nothing else,
	// and `pattern` is a request; refusing those asked the caller
	// to repeat themselves.
	const inferred =
		params.for ??
		(params.attribute !== undefined
			? "attribute"
			: params.count !== undefined
				? "count"
				: params.selector !== undefined
					? "selector"
					: params.text !== undefined
						? "text"
						: params.pattern !== undefined
							? "request"
							: params.quietMs !== undefined
								? "idle"
								: params.ms !== undefined
									? "duration"
									: undefined);

	switch (inferred) {
		case "selector":
		case "gone":
			if (!params.selector) {
				return { error: `wait '${inferred}' needs a selector.` };
			}
			return {
				condition: { kind: inferred, selector: params.selector },
			};
		case "text":
			if (!params.text) return { error: "wait 'text' needs text." };
			return { condition: { kind: "text", text: params.text } };
		case "idle":
			return {
				condition: {
					kind: "idle",
					quietMs: params.quietMs ?? DEFAULT_QUIET_MS,
				},
			};
		case "request":
			if (!params.pattern) {
				return { error: "wait 'request' needs a pattern, e.g. '*/api/*'." };
			}
			return {
				condition: {
					kind: "request",
					pattern: params.pattern,
					...(params.status === undefined ? {} : { status: params.status }),
				},
			};
		case "attribute":
			if (!params.selector || !params.attribute) {
				return {
					error: "wait 'attribute' needs a selector and an attribute.",
				};
			}
			return {
				condition: {
					kind: "attribute",
					selector: params.selector,
					attribute: params.attribute,
					...(params.value === undefined ? {} : { value: params.value }),
				},
			};
		case "count":
			if (!params.selector || params.count === undefined) {
				return { error: "wait 'count' needs a selector and a count." };
			}
			return {
				condition: {
					kind: "count",
					selector: params.selector,
					count: params.count,
				},
			};
		case "animations":
			return { condition: { kind: "animations" } };
		case "duration":
			if (params.ms === undefined) {
				return { error: "wait 'duration' needs ms." };
			}
			return { condition: { kind: "duration", ms: params.ms } };
		default:
			return {
				error:
					"wait needs a 'for': selector, gone, text, attribute, " +
					"count, idle, request, animations or duration.",
			};
	}
}

/** Parameters a gesture might be given. */
interface GestureParams {
	gesture?: string;
	x?: number;
	y?: number;
	toX?: number;
	toY?: number;
	spread?: number;
	toSpread?: number;
	count?: number;
	button?: string;
	steps?: number;
	holdMs?: number;
}

/** Mouse buttons the protocol accepts. */
const BUTTONS = new Set(["left", "middle", "right", "back", "forward"]);

/** Which gestures travel, and so need a destination. */
const TRAVELLING = new Set(["drag", "swipe", "wheel"]);

/** Which gestures are touch rather than mouse. */
const TOUCH = new Set(["tap", "longPress", "swipe", "pinch"]);

/**
 * Compose the named gesture and send it.
 *
 * Coordinates are checked before anything is dispatched, since
 * half a drag leaves the mouse button down and the page in a
 * state no later call would explain.
 */
async function runGesture(
	session: BrowserSession,
	params: GestureParams,
): Promise<{ did: string } | { error: string }> {
	const gesture = params.gesture;
	if (!gesture) {
		return {
			error:
				"input needs a gesture: click, drag, move, wheel, tap, " +
				"longPress, swipe or pinch.",
		};
	}
	if (params.x === undefined || params.y === undefined) {
		return { error: `gesture '${gesture}' needs x and y.` };
	}
	const at = { x: params.x, y: params.y };

	const travels = TRAVELLING.has(gesture);
	if (travels && (params.toX === undefined || params.toY === undefined)) {
		return { error: `gesture '${gesture}' needs toX and toY.` };
	}
	const to = { x: params.toX ?? at.x, y: params.toY ?? at.y };

	if (params.button && !BUTTONS.has(params.button)) {
		return {
			error:
				`There is no button called '${params.button}'. Use ` +
				`${[...BUTTONS].join(", ")}.`,
		};
	}
	const button = params.button as MouseButton | undefined;

	// Touch reaches the page either way, but a page that decided
	// at load time whether to attach touch handlers decided it
	// without touch emulation on, so the gesture may land on
	// nothing. Saying so beats refusing something that works.
	const caveat =
		TOUCH.has(gesture) && !session.touchEmulated
			? "\nTouch emulation is off, so the page does not believe it " +
				"has a touchscreen. If nothing happened, turn it on with " +
				"browser_go kind 'emulate' touch true and try again."
			: "";

	const steps = params.steps;
	const options = steps === undefined ? {} : { steps };

	switch (gesture) {
		case "move":
			await session.pointerGesture([
				{ type: "mouseMoved", ...at, button: "none", clickCount: 0 },
			]);
			return { did: `Moved the pointer to ${at.x}, ${at.y}.` };
		case "click": {
			const count = params.count ?? 1;
			await session.pointerGesture(
				composeClick(at, {
					...(button ? { button } : {}),
					count,
				}),
			);
			return {
				did: `Clicked at ${at.x}, ${at.y}${count > 1 ? ` ${count} times` : ""}.`,
			};
		}
		case "drag":
			await session.pointerGesture(
				composeDrag(at, to, { ...options, ...(button ? { button } : {}) }),
			);
			return {
				did: `Dragged from ${at.x}, ${at.y} to ${to.x}, ${to.y}.`,
			};
		case "wheel":
			await session.wheel(at, to.x - at.x, to.y - at.y);
			return {
				did: `Scrolled the wheel by ${to.x - at.x}, ${to.y - at.y}.`,
			};
		case "tap":
			await session.touchGesture(composeTap(at));
			return { did: `Tapped at ${at.x}, ${at.y}.${caveat}` };
		case "longPress": {
			const hold = params.holdMs ?? LONG_PRESS_MS;
			await session.touchGesture(composeLongPress(at, hold));
			return { did: `Held ${at.x}, ${at.y} for ${hold}ms.${caveat}` };
		}
		case "swipe":
			await session.touchGesture(composeSwipe(at, to, options));
			return {
				did: `Swiped from ${at.x}, ${at.y} to ${to.x}, ${to.y}.${caveat}`,
			};
		case "pinch": {
			if (params.spread === undefined || params.toSpread === undefined) {
				return {
					error:
						"pinch needs spread and toSpread: how far apart the " +
						"fingers start and end, in pixels.",
				};
			}
			await session.touchGesture(
				composePinch(at, params.spread, params.toSpread, options),
			);
			const way = params.toSpread > params.spread ? "apart" : "together";
			return {
				did:
					`Pinched ${way} around ${at.x}, ${at.y}, ` +
					`${params.spread} to ${params.toSpread}px.${caveat}`,
			};
		}
		default:
			return { error: `There is no gesture called '${gesture}'.` };
	}
}

/** Turn the tool's flat parameters into a page action. */
function buildAction(params: {
	action:
		| "click"
		| "type"
		| "hover"
		| "focus"
		| "clear"
		| "select"
		| "upload"
		| "scrollTo";
	role: string;
	name?: string;
	text?: string;
	files?: readonly string[];
	container?: string;
	ordinal?: number;
}): TargetedAction | null {
	const target: Target = {
		role: params.role,
		name: params.name,
		...(params.ordinal ? { ordinal: params.ordinal } : {}),
		...(params.container ? { container: { name: params.container } } : {}),
	};
	// Typing and selecting are the only actions that carry a
	// value, and neither means anything without one.
	if (params.action === "type" || params.action === "select") {
		if (params.text === undefined) return null;
		return { kind: params.action, target, text: params.text };
	}
	// An upload with no files is the same empty gesture as a type
	// with no text, and refusing it says so in the same words.
	if (params.action === "upload") {
		if (params.files === undefined || params.files.length === 0) return null;
		return { kind: "upload", target, files: params.files };
	}
	return { kind: params.action, target };
}
