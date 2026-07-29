/**
 * The working layer: branches, commits, trees and stacks.
 *
 * Reviewing a change and working on one are different jobs, and
 * this is the second. It is deliberately not called `git`: git is
 * one implementation of it, and on a stacked workflow the backend
 * that tracks the stack knows things plain git cannot be asked.
 *
 * Only the trees question is answered so far, and only its first
 * half: where a tree gets cut from. That half is here first
 * because the council cannot become provider-agnostic until it
 * stops asking a forge-shaped question, and this is the shape of
 * the answer.
 */

export type { TreeSource } from "./tree.js";
export { treeSource } from "./tree.js";
