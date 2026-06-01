---
name: markdown-standard
description: >
  Markdown structure rules: Title Case headings with their
  exceptions, the line-width target and its legitimate
  exceptions, reference-style links, fenced code blocks with
  language tags, tables and lists. Use when writing or editing
  any markdown file (README, AGENTS, docs, plans, skill files),
  or when adding a heading, link, table or code block. Owns
  markdown structure; pairs with prose-standard, which owns
  voice, grammar, spelling and punctuation.
---

# Markdown Standard

Markdown documents are read by humans first. The rules here keep
the source legible in a plain text editor, the rendered output
legible in a browser and the diff legible on a PR.

This skill owns markdown *structure*: headings, line width,
links, code blocks, tables and lists. It does not own *voice*.
Spelling (Canadian English), punctuation (no emdashes, no curly
quotes, no Unicode ellipsis), tone, grammar and sentence
structure all come from `prose-standard`, and that skill is the
single source for them. When this skill mentions prose, it is
pointing at prose-standard, not restating it.

## Headings

All headings use Title Case. Capitalize the first and last word,
every noun, verb, adjective, adverb and pronoun. Leave articles
(a, an, the), short prepositions (of, in, on, at, to, for, with,
by, from, as) and coordinating conjunctions (and, or, but, nor,
so, yet) lowercase unless they appear in first or last position.

Exceptions stay verbatim:

- Backticked code: `` `Bench.Run` ``, `` `dev check` ``.
- Dotted or slashed identifiers: `vantage.Prepare`, `site/host`,
  `docs/intent/site.md`.
- ALLCAPS abbreviations: CLI, JSON, SDK, API.
- Mixed-case tokens: V1, V3, CamelCase.

Don't put an inline link inside a heading; it pushes the line
long and reads as clutter. When a heading carries a reference,
use a reference-style label and define it at the bottom of the
file.

## Line Width

The target is 80 characters. Hard-wrap paragraphs at that width.

The target is not a religious rule. Three cases legitimately
exceed it:

- **Atomic tokens that don't break.** A backticked file path
  like `~/src/localhost/documents/projects/...` is one token;
  breaking it inside the backticks would break the path. Leave
  it.
- **Table rows.** Markdown tables don't soft-wrap; every row is
  one logical line and the column widths decide the length.
  Don't reformat a table to chase the 80-char rule; the
  readability cost is greater than the rule serves.
- **Long URLs in reference definitions.** A `[label]:
  https://example.com/very/long/url` line is one URL token.
  Leave it.

In every other case, wrap.

One artifact is exempt from hard wrap entirely: a PR description.
GitHub reflows markdown, and hard-wrapping a PR body breaks
quote-reply and renders raggedly. See `github-pr-format`. Every
other markdown file wraps at 80.

## Links

Use reference-style links with definitions at the end of the
file. Inline `[text](url)` links are noise in the source diff
and clutter the body prose; the reference-style form gives the
reader a clean paragraph and a single place at file end where
the URLs live.

Inline, write `[descriptive label][1]`. At the bottom of the
file, write `[1]: https://...` on its own line. The label is the
descriptive prose the reader scans, not "here" or "this link".
Reuse a number for a repeated URI. Sequence the definitions at
the bottom in the order the labels first appear in the body.

Reference definitions look like:

```
[1]: https://example.com/some/long/url
[2]: ../docs/some-plan/PLAN.md
```

One exception: an index document whose whole purpose is to list
links keeps its inline links. The document is the index, and
reference style there would just add noise.

## Code Blocks

Fence code blocks with three backticks and tag the language:

````
```go
func main() { /* ... */ }
```
````

The language tag enables syntax highlighting and makes the diff
scannable. Use standard identifiers (`go`, `sh`, `bash`, `yaml`,
`json`, `ts` and the like). Leave the tag off only for output
samples, where no language applies.

The contents of a code block aren't wrapped to 80 characters
automatically. A long line inside a code block is usually a sign
the example needs refactoring.

## Tables

Tables are for genuinely tabular data: a fixed set of columns
with a small number of distinct values per row. They are not a
formatting trick to align bullet points; use a list for that. A
two-column `Item` / `Description` table is usually a definition
list pretending to be a table, write it as a list with bold
leaders instead: `- **Item.** Description.`

Tables don't wrap. A row's length is whatever the columns add up
to. Don't reformat a table for the 80-char rule; just don't make
it wider than it needs to be. Prose inside a cell follows
prose-standard; the cell just doesn't wrap.

## Lists

Bulleted lists use `-` (preferred) or `*` (acceptable; don't mix
within a list). Numbered lists use `1.`, `2.` and so on. Indent
continuation lines to match the bullet's text position:

```
- The first line of the bullet describes the topic in
  a sentence.
- The second bullet continues the list.
```

Whether a list item takes a terminal period follows
prose-standard: imperative or concept-expressing items are
complete sentences with periods; pure noun phrases enumerating
things don't get them.

## Frontmatter

Skill files carry YAML frontmatter delimited by `---` at the
top. The frontmatter has:

- `name`: the skill's stable identifier (lowercase, hyphens, no
  underscores).
- `description`: a one-paragraph description of the skill's
  scope and load triggers. Pi's auto-loader matches it against
  the current task, so it should name the file types,
  identifiers and verbs that signal the skill applies.

The frontmatter description is one long line of YAML. Treat that
as an explicit exception to the 80-char rule; the renderer
doesn't show it and the parser doesn't care.

## Self-Checks Before Shipping

Run through these before committing a markdown change:

1. Are all the headings in Title Case, with the verbatim
   exceptions left alone?
2. Are all the paragraph lines under 80 characters, except the
   three exempted cases (and PR descriptions, which don't wrap)?
3. Are all the links reference-style with definitions at the
   file end, unless the file is an index that keeps inline links
   by design?
4. Are all the code blocks fenced with a language tag, except
   output samples?
5. Do the prose checks from prose-standard pass (Canadian
   spelling, no emdashes, no curly quotes, no Unicode ellipsis,
   single sentence spacing)?

If any answer is "no", fix before committing.

## Common Mistakes

- **Headings with inline links.** The URL goes inside the
  heading and pushes the line long. Move it to a reference label
  defined at the bottom.
- **Lowercase prose carried into a heading.** `## the contract
  cascade` reads half-edited. Title Case is the convention for
  every heading.
- **Mixing inline and reference links in one file.** Pick one.
  Reference style is the default; index files are the exception.
- **Tables used as bullet-list formatting.** Use a list with
  bold leaders instead.
- **Code blocks without language tags.** Tag the block, except
  for output samples.
- **Trailing whitespace.** Empty lines with spaces, lines with
  trailing spaces. They render the same as clean lines but show
  in the diff as noise.
