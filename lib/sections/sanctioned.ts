/**
 * The closed set of sanctioned section headings, one set per
 * artifact. Each entry is the exact heading string the body must
 * use: the hashes, the emoji and the name together.
 *
 * These constants are the single source the gate enforces, but
 * the skills are the single source of truth for what the
 * conventions are. tests/lib/sections/sanctioned.test.ts asserts
 * that each constant matches the Body Structure section of its
 * format skill, so the two cannot drift apart (a heading renamed
 * in the skill without updating the constant fails the test).
 */

/** The PR body's three required sections, in order. */
export const PR_SECTIONS = [
	"### 🌐 Situation",
	"### 🔧 Resolution",
	"### 🔬 Validation",
] as const;

/** The issue body's three required sections, in order. */
export const ISSUE_SECTIONS = [
	"### 🌐 Situation",
	"### 🎯 Outcome",
	"### ✅ Acceptance",
] as const;
