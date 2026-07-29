/**
 * The working layer: branches, commits, trees and stacks.
 *
 * Reviewing a change and working on one are different jobs, and
 * this is the second. It is deliberately not called `git`: git is
 * one implementation of it, and on a stacked workflow the backend
 * that tracks the stack knows things plain git cannot be asked.
 *
 * Only the trees question is answered so far: where a tree gets
 * cut from, and whether one already on disk answers a fresh
 * request. Both are here before the council moves across, because
 * the council cannot become provider-agnostic while it is asking a
 * forge-shaped question.
 */

export type { HeldTree, TreeBroker, TreeProvider } from "./broker.js";
export { createTreeBroker } from "./broker.js";
export type { TreeProviderChoice, TreeProviderInfo } from "./provider.js";
export { chooseTreeProvider } from "./provider.js";
export type { TreeIdentity, TreeRequest, TreeSource } from "./tree.js";
export { satisfies, treeIdentity, treeSource } from "./tree.js";
