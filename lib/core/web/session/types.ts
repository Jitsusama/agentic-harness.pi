/**
 * The shapes a browser session's answers come in: what an
 * inspection, a capture, an observation or an act hands back, and
 * how a session is opened.
 *
 * Kept apart from the session because every collaborator that
 * produces one of these answers needs its shape, and the session
 * itself re-exports them for its callers. Shapes change when an
 * answer gains a field, which is a different reason from how the
 * browser is driven to produce it.
 */

import type { SessionRef } from "../../session/index.ts";
import type { AxNode } from "../a11y/index.ts";
import type {
	Animation,
	BoxModel,
	DelegatedListeners,
	Listener,
	Measurement,
	PseudoState,
	PseudoVariant,
	VisibilityVerdict,
} from "../element/index.ts";
import type { PropertyTrace, StyleGroup } from "../styles/index.ts";
import type { Target, TargetRefusal } from "../target/index.ts";

/** How a page should be laid out for reading. */
export type PageForm = "outline" | "reading";

/** One node of Chrome's frame tree, as much of it as we read. */
export interface FrameTreeNode {
	readonly frame: { readonly id: string };
	readonly childFrames?: readonly FrameTreeNode[];
}

/** What else to gather while inspecting an element. */
export interface InspectOptions {
	/** Exactly these properties instead of the curated set. */
	readonly styles?: readonly string[];
	/** Trace why this one property has the value it has. */
	readonly why?: string;
	/** Also report what is listening and what is moving. */
	readonly behaviour?: boolean;
	/** Hold each of these states and report what changes. */
	readonly states?: readonly PseudoState[];
}

/**
 * What came of measuring between two elements.
 *
 * A target refusal is passed through with the target that earned
 * it, so the caller can say which of the two they named was the
 * problem rather than making them inspect both to find out.
 */
export type MeasureResult =
	| { readonly ok: true; readonly measurement: Measurement }
	| {
			readonly ok: false;
			readonly target: Target;
			readonly refusal: TargetRefusal;
	  }
	| { readonly ok: false; readonly problem: string };

/** A font the browser really used, and how much of it. */
export interface RenderedFont {
	readonly family: string;
	readonly glyphs: number;
}


/** Everything the browser will say about one element. */
export interface Inspection {
	readonly node: AxNode;
	readonly visibility: VisibilityVerdict;
	/**
	 * What the element actually says, as opposed to what it is
	 * called. A counter reading "42" has an accessible name that
	 * mentions no number.
	 */
	readonly text?: string;
	/** What a field is holding, which its name never says. */
	readonly value?: string;
	/** Data and state attributes, which the a11y tree cannot see. */
	readonly attributes?: Readonly<Record<string, string>>;
	/** The fonts actually painted, as opposed to the stack asked for. */
	readonly fonts?: readonly RenderedFont[];
	readonly box?: BoxModel;
	readonly styles?: readonly StyleGroup[];
	readonly trace?: PropertyTrace;
	readonly listeners?: readonly Listener[];
	/**
	 * Handlers on ancestors, which events from here still reach.
	 * Delegation is how most frameworks bind, so without these an
	 * element that is listened to reads as one that is not.
	 */
	readonly delegated?: readonly DelegatedListeners[];
	readonly animations?: readonly Animation[];
	readonly variants?: readonly PseudoVariant[];
}

/** An inspection, or the refusal that stopped it. */
export type InspectResult =
	| { readonly ok: true; readonly inspection: Inspection }
	| { readonly ok: false; readonly refusal: TargetRefusal };

/** What to photograph. */
export interface ShotOptions {
	/** One element rather than the page. */
	readonly target?: Target;
	/** The whole scrollable page rather than what is on screen. */
	readonly fullPage?: boolean;
	/** Hold this state while capturing. */
	readonly state?: PseudoState;
}

/** Where the images landed, and what had to be left out. */
export interface Shot {
	readonly paths: readonly string[];
	readonly truncated: boolean;
	readonly width: number;
	readonly height: number;
}

/** A capture, or the refusal that stopped it. */
export type ShotResult =
	| { readonly ok: true; readonly shot: Shot }
	| { readonly ok: false; readonly refusal: TargetRefusal };

/** The result of observing a page. */
export interface Observation {
	readonly url: string;
	readonly title: string;
	readonly outline: string;
	/**
	 * The tree the outline was rendered from, already scoped.
	 *
	 * The rendered outline is for reading and the tree is for
	 * querying, and a caller who stores one so the other can be
	 * narrowed needs them to be the same capture. Deriving the tree
	 * again afterwards would read a page that has moved on.
	 */
	readonly tree: AxNode;
}

/** An action that operates on a named element. */
export type TargetedAction =
	| { kind: "click"; target: Target }
	| { kind: "type"; target: Target; text: string }
	| { kind: "hover"; target: Target }
	| { kind: "focus"; target: Target }
	| { kind: "clear"; target: Target }
	| { kind: "select"; target: Target; text: string }
	| { kind: "upload"; target: Target; files: readonly string[] }
	| { kind: "scrollTo"; target: Target };

/** An action to perform against the page. */
export type PageAction = { kind: "navigate"; url: string } | TargetedAction;

/** Why an act could not target an element, and what would work. */
export type ActFailure = { ok: false; refusal: TargetRefusal };

/** An element that never became ready, and what held it up. */
export interface Blocked {
	readonly ready: false;
	readonly waitedMs: number;
	readonly blocker: string;
}

/** The outcome of an act call. */
export type ActResult =
	| { ok: true; waitedMs?: number }
	| ActFailure
	| { ok: false; blocked: Blocked };

/** The outcome of reading one named branch of a page. */
export type ObserveResult =
	| { ok: true; observation: Observation }
	| { ok: false; refusal: TargetRefusal };

/** How a session should behave for its whole life. */
export interface SessionOptions {
	/** Caller identity for captured artifacts; defaults to ambient identity in a host. */
	readonly artifactRef?: SessionRef;
	/**
	 * Carry the user's own Chrome cookies into this session, so
	 * internal apps that expect a signed-in browser are drivable.
	 * Off by default: a session is a clean user unless asked.
	 */
	readonly cookies?: boolean;
	/**
	 * Where durable artifacts a user might want to look at (right
	 * now, comparison baselines) are written. Defaults to an
	 * adapter-neutral XDG data directory shared across whatever
	 * drives this library; an adapter with its own established
	 * convention for durable data passes its own root instead.
	 */
	readonly dataRoot?: string;
}

/** Chrome cookie injection was asked for but is not set up. */
export class CookieSetupNeeded extends Error {
	constructor() {
		super(
			"Chrome cookie injection is not set up. Run Chrome cookie " +
				"setup, or open the browser without cookies.",
		);
		this.name = "CookieSetupNeeded";
	}
}

