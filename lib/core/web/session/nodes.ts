/**
 * One element as the protocol sees it: a handle on it, its boxes,
 * what it computes to and why, what listens on it, what moves on
 * it, how it looks in a forced state and what is painted over it.
 *
 * Kept apart from the session because these are the reads every
 * other part builds on, the inspection, the act, the capture and
 * the contrast judgement alike, and they change when Chrome's
 * protocol does rather than when any one of those does. Each read
 * goes through the session's live wires, so a crash recovery that
 * replaces the tab is never read past.
 */

import { bounded } from "../bound.ts";
import {
	ANCESTORS_PROBE,
	ANIMATIONS_PROBE,
	type Animation,
	type BoxModel,
	type DelegatedListeners,
	diffStyles,
	type Listener,
	normalizeAnimations,
	normalizeBoxModel,
	normalizeListeners,
	OCCLUDER_PROBE,
	PAINTING_ELEMENT_PROBE,
	type PseudoState,
	type PseudoVariant,
	type RawAnimation,
	type RawBoxModel,
	type RawListener,
	SETTLE_PROBE,
} from "../element/index.ts";
import {
	asCall,
	COMPUTED_STYLE_PROBE,
	type ComputedStyles,
	curateStyles,
	INITIALS_PROBE,
	normalizeCascade,
	type PropertyTrace,
	type RawMatchedStyles,
	SHORTHAND_PROPERTIES,
	type StyleGroup,
	traceProperty,
} from "../styles/index.ts";
import type { SourceMapStore } from "./sourcemaps.ts";
import type { InspectOptions } from "./types.ts";
import type { SessionWires } from "./wires.ts";

/**
 * How long to let a state settle before reading it.
 *
 * Forcing a state starts whatever transition the page declared,
 * so a reading taken at once catches the resting values and
 * reports that nothing changed. The wait is on the browser's
 * own promise that its animations have finished; this only caps
 * a page that keeps starting new ones.
 */
const SETTLE_CAP_MS = 2000;

/** How long past its own cap the transition probe may run. */
const SETTLE_CAP_SLACK_MS = 500;

/** What reading a node needs of the session beyond its wires. */
export interface NodeHooks {
	/** Where a stylesheet position was written, when a map says. */
	readonly authoredForSheet: SourceMapStore["authoredForSheet"];
}

/** One element's reads, through the session's protocol channel. */
export class SessionNodes {
	/** What every property computes to untouched, read once. */
	private initialStyles?: ComputedStyles;

	/** The live view of the browser the nodes are read through. */
	private readonly wires: SessionWires;

	/** What the session lends beyond its wires. */
	private readonly hooks: NodeHooks;

	constructor(wires: SessionWires, hooks: NodeHooks) {
		this.wires = wires;
		this.hooks = hooks;
	}

	/**
	 * A handle on the element inside this session.
	 *
	 * Object identifiers belong to the protocol session that
	 * minted them, so puppeteer's own handles are unusable here.
	 * A backend node id is the identity both sides agree on.
	 */
	async objectFor(backendNodeId: number): Promise<string | undefined> {
		try {
			const { object } = await this.wires.cdp().send("DOM.resolveNode", {
				backendNodeId,
			});
			return object.objectId;
		} catch {
			// The node can go out of the document between being named
			// and being looked at; the inspection reports what it can.
			return undefined;
		}
	}

	/**
	 * Swap a text node for the element that paints it.
	 *
	 * A `StaticText` target resolves to a text node, which is right
	 * for reading its box and wrong for everything that touches
	 * style. Returns the original handle when it is already an
	 * element, so callers can promote unconditionally.
	 */
	async paintingElement(objectId: string): Promise<string> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: PAINTING_ELEMENT_PROBE,
			});
			return result.objectId ?? objectId;
		} catch {
			// A detached node has no painting element either, and the
			// caller's own reads will report what it could not find.
			return objectId;
		}
	}

	/** Let go of a handle, whether or not the page still has it. */
	async release(objectId: string | undefined): Promise<void> {
		if (!objectId) return;
		await this.wires
			.cdp()
			.send("Runtime.releaseObject", { objectId })
			// Releasing a handle the page already dropped is not a
			// failure worth surfacing.
			.catch(() => {});
	}

	/**
	 * Whether something is painted over the element's centre.
	 *
	 * Only the centre, unlike a full inspection: this runs on
	 * every poll, and the centre is where a click is aimed.
	 */
	async coveredAtCentre(backendNodeId: number): Promise<string | undefined> {
		const objectId = await this.objectFor(backendNodeId);
		if (!objectId) return undefined;
		try {
			return await this.hitTest(objectId, false);
		} finally {
			await this.release(objectId);
		}
	}

	/** What is listening on the element. */
	async listenersOf(objectId: string): Promise<readonly Listener[]> {
		try {
			const { listeners } = (await this.wires
				.cdp()
				.send("DOMDebugger.getEventListeners", { objectId })) as {
				listeners: RawListener[];
			};
			return normalizeListeners(listeners);
		} catch {
			// Without the debugger agent this one section is missing;
			// the rest of the inspection still stands.
			return [];
		}
	}

	/**
	 * What is listening further up, which events from here reach.
	 *
	 * The protocol reads listeners off one object at a time and can
	 * walk down into children but not up, so the ancestors are
	 * collected in the page and each one asked separately. A live
	 * button whose click was handled on the body reported nothing
	 * listening, which is the answer that most invites the wrong
	 * conclusion from an inspection meant to explain a dead click.
	 */
	async delegatedTo(objectId: string): Promise<readonly DelegatedListeners[]> {
		try {
			const { result } = (await this.wires
				.cdp()
				.send("Runtime.callFunctionOn", {
					objectId,
					functionDeclaration: ANCESTORS_PROBE,
					returnByValue: false,
				})) as { result: { objectId?: string } };
			if (!result.objectId) return [];
			try {
				return await this.listenersUp(result.objectId);
			} finally {
				await this.release(result.objectId);
			}
		} catch {
			// The element's own handlers are the answer more often than
			// not, and they are already in hand. Losing the ancestors
			// costs a section, not the inspection.
			return [];
		}
	}

	/** Ask each ancestor in the array what is listening on it. */
	private async listenersUp(
		arrayId: string,
	): Promise<readonly DelegatedListeners[]> {
		const { result } = (await this.wires.cdp().send("Runtime.getProperties", {
			objectId: arrayId,
			ownProperties: true,
		})) as {
			result: readonly {
				name: string;
				value?: { objectId?: string; description?: string };
			}[];
		};
		const found: DelegatedListeners[] = [];
		for (const property of result) {
			// getProperties hands back 'length' and the indices together.
			if (!/^\d+$/.test(property.name)) continue;
			const ancestor = property.value?.objectId;
			if (!ancestor) continue;
			try {
				const listeners = await this.listenersOf(ancestor);
				if (listeners.length > 0) {
					found.push({
						element: property.value?.description ?? "an ancestor",
						listeners,
					});
				}
			} finally {
				await this.release(ancestor);
			}
		}
		return found;
	}

	/** What is moving on the element. */
	async animationsOf(objectId: string): Promise<readonly Animation[]> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: ANIMATIONS_PROBE,
				returnByValue: true,
			});
			return normalizeAnimations((result.value ?? []) as RawAnimation[]);
		} catch {
			// A page that navigated mid-inspection has nothing left to
			// report here.
			return [];
		}
	}

	/**
	 * How the element looks in each state, against how it looks at
	 * rest.
	 *
	 * The forced state is always released afterwards, including
	 * when a reading throws part way through. Leaving a page stuck
	 * in a forced hover would quietly corrupt every later
	 * observation of it.
	 */
	async variantsOf(
		backendNodeId: number,
		objectId: string,
		atRest: readonly StyleGroup[],
		states: readonly PseudoState[],
		initials: ComputedStyles | undefined,
		options: InspectOptions,
	): Promise<readonly PseudoVariant[]> {
		const nodeId = await this.frontendNodeFor(backendNodeId);
		if (nodeId === undefined) return [];

		const variants: PseudoVariant[] = [];
		try {
			for (const state of states) {
				await this.wires.cdp().send("CSS.forcePseudoState", {
					nodeId,
					forcedPseudoClasses: [state],
				});
				await this.settleForcedState(objectId);
				const held = await this.stylesOf(objectId);
				if (!held) continue;
				variants.push({
					state,
					changes: diffStyles(
						atRest,
						curateStyles(held, {
							...(initials === undefined ? {} : { initials }),
							...(options.styles === undefined ? {} : { only: options.styles }),
						}),
					),
				});
			}
		} finally {
			await this.wires
				.cdp()
				.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] })
				// A page that navigated took the forced state with it.
				.catch(() => {});
			// Releasing the state starts the transition back, so the
			// element is only truly as it was found once that has
			// finished. Without this the next reading catches it part
			// way home and reports a colour nobody chose.
			await this.settleForcedState(objectId);
		}
		return variants;
	}

	/**
	 * Let whatever the forced state started finish before reading.
	 *
	 * Without this the reading catches a transition at its resting
	 * values and reports that the state changes nothing, which is
	 * exactly backwards.
	 */
	async settleForcedState(objectId: string): Promise<void> {
		try {
			// The probe caps itself on the page's own timer, which a
			// page that runs no script never fires, so the cap is kept
			// here as well.
			await bounded(
				this.wires.cdp().send("Runtime.callFunctionOn", {
					objectId,
					functionDeclaration: SETTLE_PROBE,
					arguments: [{ value: SETTLE_CAP_MS }],
					awaitPromise: true,
					returnByValue: true,
				}),
				{
					wallMs: SETTLE_CAP_MS + SETTLE_CAP_SLACK_MS,
					what: "waiting for transitions",
				},
			);
		} catch {
			// A reading taken early is worse than one taken late, but
			// neither is worth abandoning the inspection over.
		}
	}

	/** The front-end node id, which the CSS agent works in. */
	async frontendNodeFor(backendNodeId: number): Promise<number | undefined> {
		try {
			// A front-end id only exists once the document has been
			// walked at least once.
			await this.wires.cdp().send("DOM.getDocument", { depth: 0 });
			const { nodeIds } = await this.wires
				.cdp()
				.send("DOM.pushNodesByBackendIdsToFrontend", {
					backendNodeIds: [backendNodeId],
				});
			return nodeIds[0];
		} catch {
			// Without a front-end id the CSS agent cannot be addressed.
			return undefined;
		}
	}

	/** The element's four boxes, or nothing when it has none. */
	async boxOf(backendNodeId: number): Promise<BoxModel | undefined> {
		try {
			const { model } = (await this.wires.cdp().send("DOM.getBoxModel", {
				backendNodeId,
			})) as { model: RawBoxModel };
			return normalizeBoxModel(model);
		} catch {
			// An element with display none has no box at all, and the
			// protocol says so by refusing. That is an answer, not a
			// failure: the visibility verdict reports it as unrendered.
			return undefined;
		}
	}

	/** Every computed property of the element, as the browser has it. */
	async stylesOf(objectId: string): Promise<ComputedStyles | undefined> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: COMPUTED_STYLE_PROBE,
				arguments: [{ value: SHORTHAND_PROPERTIES }],
				returnByValue: true,
			});
			return result.value as ComputedStyles;
		} catch {
			// A page that navigated mid-inspection leaves nothing to
			// read; the rest of the inspection still stands.
			return undefined;
		}
	}

	/**
	 * What every property computes to untouched, read once per
	 * session. These decide which values were actually chosen.
	 */
	async initials(): Promise<ComputedStyles | undefined> {
		if (this.initialStyles) return this.initialStyles;
		try {
			const { result } = await this.wires.cdp().send("Runtime.evaluate", {
				expression: asCall(INITIALS_PROBE, SHORTHAND_PROPERTIES),
				returnByValue: true,
			});
			this.initialStyles = result.value as ComputedStyles;
			return this.initialStyles;
		} catch {
			// Without these nothing is suppressed as a default, which
			// is verbose but never wrong.
			return undefined;
		}
	}

	/** Why one property has the value it has. */
	async traceOf(
		backendNodeId: number,
		property: string,
		styles: ComputedStyles | undefined,
	): Promise<PropertyTrace | undefined> {
		try {
			const nodeId = await this.frontendNodeFor(backendNodeId);
			if (nodeId === undefined) return undefined;
			const raw = (await this.wires.cdp().send("CSS.getMatchedStylesForNode", {
				nodeId,
			})) as RawMatchedStyles;
			const trace = traceProperty(
				normalizeCascade(raw),
				property,
				styles?.[property],
			);
			return trace === undefined ? undefined : await this.authorTrace(trace);
		} catch {
			// The cascade domain needs the CSS agent; without it the
			// rest of the inspection is still worth returning.
			return undefined;
		}
	}

	/**
	 * Tell each declaration in a trace where it was written.
	 *
	 * A build step that rewrote the CSS makes the reported line
	 * useless in the same way a minified stack frame is: it names
	 * a file nobody edits. The winner is usually the declaration
	 * somebody wants to go and change, so it is the one that most
	 * needs an address that exists.
	 */
	private async authorTrace(trace: PropertyTrace): Promise<PropertyTrace> {
		const declarations = await Promise.all(
			trace.declarations.map(async (declaration) => {
				const { source } = declaration;
				if (source?.styleSheet === undefined || source.line === undefined) {
					return declaration;
				}
				const authored = await this.hooks.authoredForSheet(source.styleSheet, {
					line: source.line,
					column: source.column ?? 0,
				});
				if (authored === undefined) return declaration;
				return { ...declaration, source: { ...source, authored } };
			}),
		);
		// The winner is compared by identity, so it has to be
		// re-found among the rebuilt declarations rather than kept.
		const winnerAt = trace.winner
			? trace.declarations.indexOf(trace.winner)
			: -1;
		return {
			...trace,
			declarations,
			...(winnerAt < 0 ? {} : { winner: declarations[winnerAt] }),
		};
	}

	/** The area a person can currently see. */
	async viewport(): Promise<{ width: number; height: number } | undefined> {
		try {
			const metrics = (await this.wires
				.cdp()
				.send("Page.getLayoutMetrics")) as {
				cssVisualViewport?: { clientWidth: number; clientHeight: number };
			};
			const seen = metrics.cssVisualViewport;
			if (!seen) return undefined;
			return { width: seen.clientWidth, height: seen.clientHeight };
		} catch {
			// Without the viewport an element is judged on everything
			// else known about it rather than not at all.
			return undefined;
		}
	}

	/**
	 * How far the page has been scrolled, in CSS pixels.
	 *
	 * Read from the browser's own layout metrics rather than from the
	 * page, so a capture does not have to run script to be correct.
	 * Answers zero when the metrics are unavailable, which is what the
	 * offset was assumed to be before it was asked for at all.
	 */
	async scrollOffset(): Promise<{ x: number; y: number }> {
		try {
			const metrics = (await this.wires
				.cdp()
				.send("Page.getLayoutMetrics")) as {
				cssVisualViewport?: { pageX?: number; pageY?: number };
			};
			const seen = metrics.cssVisualViewport;
			return { x: seen?.pageX ?? 0, y: seen?.pageY ?? 0 };
		} catch {
			// A page that went away mid-capture has no offset to report,
			// and the capture around this will fail on its own terms.
			// Zero is what the clip assumed before the offset was asked
			// for at all, so it is the honest fallback rather than a new
			// guess.
			return { x: 0, y: 0 };
		}
	}

	/**
	 * What is painted over the element, if anything.
	 *
	 * The centre and the corners, since a full inspection should
	 * report an element clipped at one edge. Anything the element
	 * contains counts as itself, since a click there still reaches
	 * it.
	 */
	async occluderOf(objectId: string): Promise<string | undefined> {
		return await this.hitTest(objectId, true);
	}

	/**
	 * Who receives a click, when it is not us.
	 *
	 * The point is chosen inside the page rather than out here. Both
	 * halves of the question used to be asked separately, the box
	 * from the box model and the hit from `DOM.getNodeForLocation`,
	 * and they disagree by the scroll offset, so anything the driver
	 * had to scroll to was reported as covered by whatever sat at
	 * the wrong point.
	 */
	private async hitTest(
		objectId: string,
		alsoCorners: boolean,
	): Promise<string | undefined> {
		try {
			const { result } = await this.wires.cdp().send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: OCCLUDER_PROBE,
				arguments: [{ value: alsoCorners }],
				returnByValue: true,
			});
			return (result.value as string | null) ?? undefined;
		} catch {
			// An element that has gone from the page between resolving
			// and asking cannot be occluded by anything, and the next
			// poll reports it as absent.
			return undefined;
		}
	}
}
