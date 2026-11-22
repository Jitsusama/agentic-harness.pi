/**
 * What `tsc` reads in place of googleapis' root and every entry above one
 * API's folder: nothing, so a type taken from any of them fails the
 * typecheck here rather than passing it 3.4 million lines heavier.
 *
 * tsconfig.json's `paths` maps those entries here. The real root reaches
 * all 328 Google APIs' declarations, which were three in four of every
 * line `tsc` read for this project until 22 November. Take a type from
 * one API's own module instead, `googleapis/build/src/apis/<api>`, as
 * `client.ts` does.
 *
 * This maps types only. `client.ts` still loads the real package at run
 * time, through a `require` the typechecker does not follow.
 */
export {};
