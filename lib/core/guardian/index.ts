/**
 * The portable half of the guardian contract: the result shape a
 * content gate hands back. Registration and redirect formatting
 * stay adapter-local -- they wire into a host's own tool-call
 * interception, which every adapter does differently.
 */

export { ALLOW, type GuardianBlock, type GuardianResult } from "./types.ts";
