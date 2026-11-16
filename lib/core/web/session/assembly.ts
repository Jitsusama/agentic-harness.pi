/**
 * How a browser session's collaborators are built and wired to one
 * another: which of them reads through which, and which hooks each
 * lends the others.
 *
 * Kept apart from the session because the wiring changes whenever
 * a collaborator gains or drops a dependency, while the session's
 * own surface changes only when a caller can ask for something new.
 * Every collaborator drives the browser through the same live wires,
 * so a crash recovery that replaces the tab reaches all of them.
 */

import { readFileSync } from "node:fs";
import type { CDPSession, Page } from "puppeteer-core";
import { SessionActing } from "./acting.ts";
import { ArtifactLedger } from "./artifacts.ts";
import { images, SessionCamera } from "./camera.ts";
import { SessionContrast } from "./contrast.ts";
import { EmulationController } from "./emulation.ts";
import { SessionFocus } from "./focus.ts";
import { SessionInspector } from "./inspecting.ts";
import { SessionNavigation } from "./navigation.ts";
import { SessionNodes } from "./nodes.ts";
import { SessionPainting } from "./painting.ts";
import { SessionProbes } from "./probes.ts";
import { SessionProfiler } from "./profiling.ts";
import { PageSettler } from "./settling.ts";
import { NetworkShaper } from "./shaping.ts";
import { SourceMapStore } from "./sourcemaps.ts";
import { SessionStorage } from "./storage.ts";
import { SessionTab } from "./tab.ts";
import { SessionTargeting } from "./targeting.ts";
import { SessionTelemetry } from "./telemetry.ts";
import type { SessionOptions } from "./types.ts";
import { SessionWaiting } from "./waiting.ts";
import type { SessionWires } from "./wires.ts";

/** Every collaborator a session hands its work to. */
export interface SessionParts {
	/** The maps the page has declared, for authored positions. */
	readonly sourceMaps: SourceMapStore;
	/** What this session pretends to be, and its keeper. */
	readonly emulation: EmulationController;
	/** The rules and throttle this session's network answers to. */
	readonly shaper: NetworkShaper;
	/** What the page keeps, read and written. */
	readonly stores: SessionStorage;
	/** The page's tree, and the element a target names in it. */
	readonly targeting: SessionTargeting;
	/** One element's reads: handles, boxes, styles and listeners. */
	readonly nodes: SessionNodes;
	/** How readable the page is, judged through this session's nodes. */
	readonly contrast: SessionContrast;
	/** Layers and hover states, read through this session's nodes. */
	readonly painting: SessionPainting;
	/** The disk side of this session: sink, stamps and ledger. */
	readonly artifacts: ArtifactLedger;
	/** The wait between a change and an honest reading of it. */
	readonly settler: PageSettler;
	/** Everything this session overhears, and its buffers. */
	readonly telemetry: SessionTelemetry;
	/** The tab this session drives, kept alive through a crash. */
	readonly tab: SessionTab;
	/** Everything worth knowing about one element. */
	readonly inspector: SessionInspector;
	/** Acts on named elements, and raw input. */
	readonly acting: SessionActing;
	/** Where keyboard focus goes. */
	readonly focus: SessionFocus;
	/** One-pass readings of the page. */
	readonly probes: SessionProbes;
	/** Waits on the page reaching a state. */
	readonly waiting: SessionWaiting;
	/** Screenshots and baselines. */
	readonly camera: SessionCamera;
	/** Profiles, traces and heap readings. */
	readonly profiler: SessionProfiler;
	/** Where the tab goes, and the outline of where it arrived. */
	readonly navigation: SessionNavigation;
}

/** Who the session is, and how it takes a new tab as its own. */
export interface SessionIdentity {
	/** The session's name, for its baselines and its trace permit. */
	readonly name: string;
	/** How the session should behave for its whole life. */
	readonly options: SessionOptions;
	/** Make this the session's tab and channel from now on. */
	readonly adopt: (page: Page, cdp: CDPSession) => void;
}

/**
 * Build a session's collaborators over its wires.
 *
 * A few lend each other hooks before both exist (acting navigates,
 * probing reloads, contrast captures), so those hooks are closures
 * called only once the session is open, never while it is built.
 */
export function assembleSession(
	wires: SessionWires,
	identity: SessionIdentity,
): SessionParts {
	const { name, options } = identity;
	const sourceMaps = new SourceMapStore(wires);
	const emulation = new EmulationController(wires, {
		settle: () => settler.settle(),
	});
	const targeting = new SessionTargeting(wires);
	const nodes = new SessionNodes(wires, {
		authoredForSheet: (sheet, at) => sourceMaps.authoredForSheet(sheet, at),
	});
	const artifacts = new ArtifactLedger(options.artifactRef);
	const settler = new PageSettler(wires, () => telemetry.requests());
	const telemetry = new SessionTelemetry(wires, {
		onCrash: () => {
			tab.startRecovery();
		},
		downloadDir: () => artifacts.sink().dir,
		keep: (path) => {
			artifacts.keep(path);
		},
	});
	const tab = new SessionTab(wires, {
		adopt: identity.adopt,
		telemetry,
		sourceMaps,
		emulation,
	});
	const navigation = new SessionNavigation(wires, {
		cookies: options.cookies === true,
		emulation,
		settler,
		tab,
		targeting,
	});
	const probes = new SessionProbes(wires, emulation, sourceMaps, {
		reload: () => navigation.reload(),
	});
	const camera = new SessionCamera(wires, {
		nodes,
		targeting,
		probes,
		emulation,
		artifacts,
		name,
		dataRoot: options.dataRoot,
	});
	return {
		sourceMaps,
		emulation,
		shaper: new NetworkShaper(wires),
		stores: new SessionStorage(wires),
		targeting,
		nodes,
		contrast: new SessionContrast(wires, {
			axTree: () => targeting.axTree(),
			objectFor: (id) => nodes.objectFor(id),
			paintingElement: (id) => nodes.paintingElement(id),
			stylesOf: (id) => nodes.stylesOf(id),
			capture: (id) => camera.capture(id, {}),
			release: (id) => nodes.release(id),
			readShot: async (shot) => {
				const { readPng } = await images();
				return readPng(readFileSync(shot));
			},
		}),
		painting: new SessionPainting(wires, {
			frontendNodeFor: (id) => nodes.frontendNodeFor(id),
			objectFor: (id) => nodes.objectFor(id),
			stylesOf: (id) => nodes.stylesOf(id),
			settleForcedState: (id) => nodes.settleForcedState(id),
		}),
		artifacts,
		settler,
		telemetry,
		tab,
		inspector: new SessionInspector(wires, nodes, targeting),
		acting: new SessionActing(wires, nodes, targeting, {
			navigate: (url) => navigation.navigate(url),
		}),
		focus: new SessionFocus(wires),
		probes,
		waiting: new SessionWaiting(wires, telemetry),
		camera,
		profiler: new SessionProfiler(wires, name),
		navigation,
	};
}
