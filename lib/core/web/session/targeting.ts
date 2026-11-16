/**
 * Finding what a caller named: the page's accessibility tree with
 * its same-origin frames spliced in, and the driver's handle on the
 * one element a target resolves to.
 *
 * Kept apart from the session because naming an element the way a
 * person would is the session's one promise to its callers, and
 * every reading and act resolves through it. It changes when the
 * tree or the driver's matching does, not when what is done with
 * the element does.
 */

import type { ElementHandle } from "puppeteer-core";
import {
	type AxNode,
	type FrameAxTree,
	normalizeAxTree,
	type RawAxNode,
	spliceFrames,
} from "../a11y/index.ts";
import {
	ambiguityRefusal,
	notFoundRefusal,
	resolveTarget,
	type Target,
} from "../target/index.ts";
import type { ActFailure, FrameTreeNode } from "./types.ts";
import type { SessionWires } from "./wires.ts";

/** The page's tree, and the element a target names in it. */
export class SessionTargeting {
	/** The live view of the browser the tree is read through. */
	private readonly wires: SessionWires;

	constructor(wires: SessionWires) {
		this.wires = wires;
	}

	async axTree(): Promise<AxNode> {
		// Nearly every reading starts here, which makes it the right
		// place to wait out a crash recovery rather than issuing a
		// call to a renderer that will never answer.
		await this.wires.ready();
		const { nodes } = (await this.wires
			.cdp()
			.send("Accessibility.getFullAXTree")) as {
			nodes: RawAxNode[];
		};
		return normalizeAxTree(spliceFrames(nodes, await this.frameTrees()));
	}

	/**
	 * Each same-origin child frame's tree, and what owns it.
	 *
	 * Chrome answers for one frame at a time, so a page built from
	 * embeds read as a row of empty boxes: the outline stopped at
	 * the Iframe node and said nothing about stopping. Everything
	 * downstream inherited that, so a keyboard walk skipped an
	 * embedded form and an audit passed a page it had not seen.
	 *
	 * Breadth-first, parents before children, because the splice
	 * attaches each frame to an owner that must already be in the
	 * tree by the time its turn comes.
	 *
	 * A frame that cannot be read is left out rather than reported
	 * as empty. Cross-origin frames are the common case and are a
	 * real limit, not a fault; the count of what could not be read
	 * belongs to the callers that already report it.
	 */
	private async frameTrees(): Promise<readonly FrameAxTree[]> {
		let tree: { frameTree: FrameTreeNode };
		try {
			tree = (await this.wires.cdp().send("Page.getFrameTree")) as {
				frameTree: FrameTreeNode;
			};
		} catch {
			// No frame tree means nothing to splice, which is the answer
			// for the overwhelming majority of pages.
			return [];
		}

		const queue: FrameTreeNode[] = [...(tree.frameTree.childFrames ?? [])];
		const collected: FrameAxTree[] = [];
		while (queue.length > 0) {
			const node = queue.shift();
			if (!node) break;
			queue.push(...(node.childFrames ?? []));
			const frameId = node.frame.id;
			try {
				const { backendNodeId } = (await this.wires
					.cdp()
					.send("DOM.getFrameOwner", {
						frameId,
					})) as { backendNodeId: number };
				const { nodes } = (await this.wires
					.cdp()
					.send("Accessibility.getFullAXTree", {
						frameId,
					})) as { nodes: RawAxNode[] };
				collected.push({ ownerBackendNodeId: backendNodeId, nodes });
			} catch {
				// A cross-origin frame refuses both calls, and a frame can
				// be torn down between listing it and asking about it.
				// Neither is a reason to fail the whole read.
			}
		}
		return collected;
	}

	async resolve(
		target: Target,
	): Promise<{ ok: true; element: ElementHandle } | ActFailure> {
		// Confirm uniqueness against our own outline so an ambiguous
		// target becomes a prompt to narrow it rather than a wrong click.
		const tree = await this.axTree();
		const resolution = resolveTarget(tree, target);
		if (resolution.kind === "notFound") {
			return { ok: false, refusal: notFoundRefusal(tree, target) };
		}
		if (resolution.kind === "ambiguous") {
			return { ok: false, refusal: ambiguityRefusal(tree, target) };
		}

		// Drive the real element through puppeteer's aria selector, which
		// brings the scrolling, visibility and hit testing that a raw
		// protocol click does not. But the selector is page-wide and knows
		// nothing of a container, and its ordering is its own, so the
		// candidate that matches is chosen by the identity the resolution
		// already settled rather than by position in a second list.
		// Choosing by index here is how a click lands on the wrong row.
		// A target with no name is written with none, not with the
		// word "undefined": interpolating a missing name produced
		// aria/undefined[role="button"], which matches nothing, so an
		// element the outline had just offered refused every act.
		const handles = await this.wires
			.page()
			.$$(`aria/${target.name ?? ""}[role="${target.role}"]`);
		let element: ElementHandle | undefined;
		for (const handle of handles) {
			if (
				element === undefined &&
				(await this.backendIdOf(handle)) === resolution.backendDomId
			) {
				element = handle;
				continue;
			}
			await handle.dispose();
		}
		// The outline named a node the aria selector does not offer: the
		// page moved, or the two matchers disagree. Refusing is the only
		// honest answer, because any handle we still hold is a guess.
		if (!element) return { ok: false, refusal: notFoundRefusal(tree, target) };
		return { ok: true, element };
	}

	/**
	 * The backend node id behind a handle, or undefined if it has gone.
	 *
	 * This asks puppeteer rather than sending DOM.describeNode ourselves
	 * because a remote object id is scoped to the session that minted it,
	 * and these handles were minted by puppeteer's session, not ours.
	 * Resolving them through this.wires.cdp() fails for every handle, which reads
	 * as "no candidate matched" and refuses every act.
	 */
	private async backendIdOf(
		handle: ElementHandle,
	): Promise<number | undefined> {
		try {
			return await handle.backendNodeId();
		} catch {
			// The node left the document between the outline and this
			// lookup. It cannot be the one we resolved, so say so.
			return undefined;
		}
	}
}
