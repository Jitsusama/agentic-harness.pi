/**
 * Doing things to the page the way a person would: acting on a
 * named element once it is ready, and pressing keys, pointing,
 * scrolling and touching wherever the page is.
 *
 * Kept apart from the session because readiness and dispatch
 * change together, whenever an action needs a new precondition or
 * the driver dispatches differently, and neither has anything to
 * do with how the page is read afterwards.
 */

import type { ElementHandle, KeyInput } from "puppeteer-core";
// The key table is reached through the driver's declared
// internal subpath rather than its barrel, which marks the
// table private and strips it from the public types. Copying
// the 255 entries instead would mean maintaining a second
// opinion about which keys exist, and being wrong separately.
import { _keyDefinitions } from "puppeteer-core/internal/common/USKeyboardLayout.js";
import { subtreeAt } from "../a11y/index.ts";
import {
	type Actionability,
	type ActionabilityFacts,
	judgeActionability,
	judgeVisibility,
	type Rect,
	SELECT_TEXT_PROBE,
	sameBox,
} from "../element/index.ts";
import {
	type ChordRefusal,
	type Point,
	type PointerEventStep,
	parseChords,
	type TouchStep,
} from "../input/index.ts";
import { resolveTarget, type Target } from "../target/index.ts";
import type { SessionNodes } from "./nodes.ts";
import type { SessionTargeting } from "./targeting.ts";
import type {
	ActResult,
	Blocked,
	PageAction,
	TargetedAction,
} from "./types.ts";
import type { SessionWires } from "./wires.ts";

/**
 * Every key the driver knows how to send.
 *
 * The chord parser is given this rather than keeping its own
 * copy, so there is one table and it is the one that will
 * actually be used to dispatch.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(_keyDefinitions));

/**
 * How long to wait for an element to become ready, and how
 * often to look. A page that animates a dialog in takes a few
 * hundred milliseconds, and waiting is far cheaper than a click
 * that silently misses.
 */
const READY_BUDGET_MS = 2000;
const READY_POLL_MS = 100;

/**
 * Whether an action arrives by pointer.
 *
 * A pointer has to reach the element's centre unobstructed and
 * on screen. Everything else addresses the element directly and
 * would succeed where a click could not.
 */
function usesPointer(action: TargetedAction): boolean {
	return action.kind === "click" || action.kind === "hover";
}

/** What has to be true of an element before an action can happen. */
interface ActionNeeds {
	/** Where a pointer would land, which only a pointer cares about. */
	readonly pointer: boolean;
	/** That the element is rendered where a person could see it. */
	readonly sight: boolean;
	/**
	 * A handle from the driver's own aria selector, which brings
	 * the scrolling and hit testing a raw protocol call does not.
	 */
	readonly handle: boolean;
}

/**
 * What this action needs, which for one action is unusually
 * little.
 *
 * Choosing a file happens in the operating system's dialog, and
 * the input that receives it is nearly always hidden with a
 * styled label over it, which is the recommended way to build
 * one. So an upload asks neither to be seen nor to be reachable
 * by a pointer: it asks that the input exists and takes files.
 *
 * It also does without the driver's handle. The aria selector
 * that produces one does not offer a node it considers hidden,
 * so for the ordinary hidden input the two matchers disagree,
 * our own outline finds it and the selector does not, and the
 * act refuses something it had just listed. The file is set
 * through the protocol against the node the outline resolved.
 */
function needsOf(action: TargetedAction): ActionNeeds {
	if (action.kind === "upload") {
		return { pointer: false, sight: false, handle: false };
	}
	return { pointer: usesPointer(action), sight: true, handle: true };
}

/** What acting needs of the session beyond its element reads. */
export interface ActingHooks {
	/** Take the tab somewhere, for an act that names a url. */
	readonly navigate: (url: string) => Promise<unknown>;
}

/** Acts and raw input, dispatched through the session's tab. */
export class SessionActing {
	/** The live view of the browser the page is driven through. */
	private readonly wires: SessionWires;

	/** The node reads readiness is judged from. */
	private readonly nodes: SessionNodes;

	/** How a target becomes a node and a handle. */
	private readonly targeting: SessionTargeting;

	/** What the session lends beyond its reads. */
	private readonly hooks: ActingHooks;

	constructor(
		wires: SessionWires,
		nodes: SessionNodes,
		targeting: SessionTargeting,
		hooks: ActingHooks,
	) {
		this.wires = wires;
		this.nodes = nodes;
		this.targeting = targeting;
		this.hooks = hooks;
	}

	/** Perform an action, resolving semantic targets against the a11y tree. */
	async act(action: PageAction): Promise<ActResult> {
		if (action.kind === "navigate") {
			await this.hooks.navigate(action.url);
			return { ok: true };
		}
		// Readiness is established before targeting, because an
		// element that has not appeared yet is the commonest reason
		// an action is early rather than wrong.
		const needs = needsOf(action);
		const ready = await this.awaitReady(
			action.target,
			needs.pointer,
			needs.sight,
		);
		if (!ready.ready) {
			// Never showing up and never existing look the same from
			// here, and only one of them has a spelling suggestion
			// worth making, so ask the targeting to explain itself.
			const missing = await this.targeting.resolve(action.target);
			if (!missing.ok) return missing;
			await missing.element.dispose();
			return { ok: false, blocked: ready };
		}

		if (!needs.handle) {
			await this.perform(action, undefined, ready.backendDomId);
			if (ready.waitedMs > 0) return { ok: true, waitedMs: ready.waitedMs };
			return { ok: true };
		}

		const handle = await this.targeting.resolve(action.target);
		if (!handle.ok) return handle;

		await this.perform(action, handle.element, ready.backendDomId);
		await handle.element.dispose();
		if (ready.waitedMs > 0) return { ok: true, waitedMs: ready.waitedMs };
		return { ok: true };
	}

	/** Carry out an action against an element judged ready. */
	private async perform(
		action: TargetedAction,
		element: ElementHandle | undefined,
		backendNodeId: number,
	): Promise<void> {
		if (action.kind === "upload") {
			// Set through our own protocol channel against the node the
			// outline resolved. The driver's aria selector does not
			// offer a node it considers hidden, and a hidden input is
			// the ordinary shape of an upload, so there is no handle to
			// hold here and none is needed.
			const objectId = await this.nodes.objectFor(backendNodeId);
			if (!objectId) return;
			try {
				await this.wires.cdp().send("DOM.setFileInputFiles", {
					objectId,
					files: [...action.files],
				});
			} finally {
				await this.nodes.release(objectId);
			}
			return;
		}
		if (!element) return;
		switch (action.kind) {
			case "click":
				await element.click();
				return;
			case "type":
				await element.type(action.text);
				return;
			case "hover":
				await element.hover();
				return;
			case "focus":
				await element.focus();
				return;
			case "select":
				await element.select(action.text);
				return;
			case "scrollTo":
				await element.scrollIntoView();
				return;
			case "clear": {
				// Select what is there and delete it, so the page sees
				// the same input and change events it would from a
				// person at a keyboard. The field is asked to select
				// itself rather than triple clicked, so clearing works
				// under an overlay, and rather than sending a select-all
				// shortcut, so there is no platform to guess at.
				await element.focus();
				// Resolved through our own session: an identifier minted
				// by puppeteer's connection means nothing on this one.
				const objectId = await this.nodes.objectFor(backendNodeId);
				try {
					if (objectId) {
						await this.wires.cdp().send("Runtime.callFunctionOn", {
							objectId,
							functionDeclaration: SELECT_TEXT_PROBE,
							returnByValue: true,
						});
					}
				} finally {
					await this.nodes.release(objectId);
				}
				await this.wires.page().keyboard.press("Backspace");
				return;
			}
		}
	}

	/**
	 * Wait until an element can actually be acted on.
	 *
	 * A click on an element that is not ready does nothing and
	 * says nothing, leaving a caller believing the page was acted
	 * on. So readiness is established first, and when the budget
	 * runs out the condition still in the way is reported rather
	 * than the action being attempted regardless.
	 */
	private async awaitReady(
		target: Target,
		pointer: boolean,
		sight = true,
	): Promise<
		{ ready: true; waitedMs: number; backendDomId: number } | Blocked
	> {
		const started = Date.now();
		let previous: Rect | undefined;
		let scrolled = false;
		let last: Actionability = {
			ready: false,
			blocker: "it is not in the page",
		};

		while (Date.now() - started < READY_BUDGET_MS) {
			const look = await this.readinessOf(target, previous, pointer, sight);
			previous = look.box;
			last = judgeActionability(look.facts);
			if (last.ready && look.backendDomId !== undefined) {
				return {
					ready: true,
					waitedMs: Date.now() - started,
					backendDomId: look.backendDomId,
				};
			}
			// Waiting cannot bring an element into the viewport, so
			// polling one that is merely below the fold spends the whole
			// budget to reach the verdict it already had. Scrolling is
			// what the caller means by acting on it, and what a person
			// does. Once only: if it is still out of view after being
			// scrolled to, something else is moving it and the blocker
			// is the honest answer.
			if (!scrolled && look.facts.visibility?.state === "off screen") {
				scrolled = true;
				const found = await this.targeting.resolve(target);
				if (found.ok) {
					await found.element.scrollIntoView();
					await found.element.dispose();
					previous = undefined;
					continue;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
		}
		return {
			ready: false,
			waitedMs: Date.now() - started,
			blocker: last.blocker ?? "it never became ready",
		};
	}

	/** One look at whether an element is ready. */
	private async readinessOf(
		target: Target,
		previous: Rect | undefined,
		pointer: boolean,
		sight = true,
	): Promise<{
		facts: ActionabilityFacts;
		box: Rect | undefined;
		backendDomId?: number;
	}> {
		const tree = await this.targeting.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind !== "resolved") {
			return {
				facts: { present: false, enabled: false, settled: false },
				box: undefined,
			};
		}

		const node = subtreeAt(tree, resolution.backendDomId);
		const box = await this.nodes.boxOf(resolution.backendDomId);

		// Where the click lands only matters when there is a click.
		// Focusing, typing, choosing an option and scrolling all
		// reach an element the pointer could not, so holding them to
		// a pointer's standard refuses work that would have
		// succeeded. Being rendered at a real size still matters to
		// every action, so that part of the verdict always applies.
		const viewport = pointer ? await this.nodes.viewport() : undefined;
		const coveredBy =
			pointer && box
				? await this.nodes.coveredAtCentre(resolution.backendDomId)
				: undefined;
		const visibility = sight
			? judgeVisibility({
					rendered: box !== undefined,
					...(box === undefined ? {} : { border: box.border }),
					...(viewport === undefined ? {} : { viewport }),
					...(coveredBy === undefined ? {} : { coveredBy }),
				})
			: undefined;
		return {
			facts: {
				present: true,
				...(visibility === undefined ? {} : { visibility }),
				// The tree reports what the browser exposes to assistive
				// technology, which is the same disabled a person meets.
				enabled: node?.properties.disabled !== true,
				settled: sameBox(previous, box?.border),
			},
			box: box?.border,
			backendDomId: resolution.backendDomId,
		};
	}

	/**
	 * Press a chord, or a sequence of them.
	 *
	 * Dispatch goes through the driver's keyboard rather than the
	 * protocol directly, because the driver owns the layout table
	 * that turns a key name into a code, a virtual key number and
	 * the text it produces. Keeping a second opinion about that
	 * would be a second thing to be wrong about.
	 */
	async press(
		keys: string,
	): Promise<{ pressed: readonly string[] } | { refusal: ChordRefusal }> {
		await this.wires.ready();
		const parsed = parseChords(keys, KNOWN_KEYS);
		if ("refusal" in parsed) return parsed;

		const pressed: string[] = [];
		for (const chord of parsed.chords) {
			for (const modifier of chord.modifiers) {
				await this.wires.page().keyboard.down(modifier);
			}
			try {
				await this.wires.page().keyboard.press(chord.key as KeyInput);
			} finally {
				// Whatever the key press did, the modifiers come back up.
				// A chord that threw mid-press used to leave Control or
				// Meta logically held for the life of a session that is
				// long lived by design, so every later click became a
				// modified click and the symptom appeared calls away
				// from the cause.
				for (const modifier of [...chord.modifiers].reverse()) {
					await this.wires.page().keyboard.up(modifier).catch(() => {
						// The page may be gone; there is no key state left
						// to corrupt if it is.
					});
				}
			}
			pressed.push([...chord.modifiers, chord.key].join("+"));
		}
		return { pressed };
	}

	/** Send raw text as keystrokes, wherever focus happens to be. */
	async typeRaw(text: string): Promise<void> {
		await this.wires.ready();
		await this.wires.page().keyboard.type(text);
	}

	/** Dispatch a composed mouse gesture. */
	async pointerGesture(steps: readonly PointerEventStep[]): Promise<void> {
		await this.wires.ready();
		for (const step of steps) {
			await this.wires.cdp().send("Input.dispatchMouseEvent", {
				type: step.type,
				x: step.x,
				y: step.y,
				button: step.button,
				clickCount: step.clickCount,
			});
		}
	}

	/** Scroll by wheel, which is not the same as scrolling by script. */
	async wheel(at: Point, byX: number, byY: number): Promise<void> {
		await this.wires.ready();
		await this.wires.cdp().send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: at.x,
			y: at.y,
			deltaX: byX,
			deltaY: byY,
			button: "none",
			clickCount: 0,
		});
	}

	/**
	 * Dispatch a composed touch gesture.
	 *
	 * Touch events reach the page whether or not touch emulation
	 * is on, so this never refuses. What emulation changes is what
	 * the page believes about itself: maxTouchPoints and the
	 * coarse-pointer media query. A page that decides at load time
	 * whether to attach touch handlers will not have attached any,
	 * and the gesture lands on nothing, so the caller is told
	 * rather than stopped.
	 */
	async touchGesture(steps: readonly TouchStep[]): Promise<void> {
		await this.wires.ready();
		for (const step of steps) {
			await this.wires.cdp().send("Input.dispatchTouchEvent", {
				type: step.type,
				touchPoints: step.points.map((point) => ({
					x: point.x,
					y: point.y,
					id: point.id,
				})),
			});
			if (step.pauseMs) {
				await new Promise((resolve) => setTimeout(resolve, step.pauseMs));
			}
		}
	}
}
