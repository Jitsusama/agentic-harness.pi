---
name: planning-dev-format
description: >
  Plan structure for code implementation work. Context,
  interfaces, data flow and behaviours without writing the
  implementation itself. Use during plan_mode when the work
  involves building or modifying code. Pairs with
  planning-guide for the overall planning methodology.
---

# Development Planning

## Core Principle

**Plans provide context and direction, not implementation.**

Plans explain WHAT to build and WHY. Implementation (via TDD)
determines HOW. The plan should give enough context that the
person implementing can make intelligent decisions.

## Essential Plan Sections

### 1. Skills to Follow

Reference the skills the implementer should load during
implementation. Don't rewrite their content; just name them:

```markdown
Follow TDD workflow (see code-tdd-guide skill) for implementation.
Follow code-style-standard skill for design and style.
Follow prose-standard skill for comments, docs and descriptions.
```

The implementer loads these skills and applies them. Plans
don't need to repeat the guidance.

### 2. Context from Research

Include findings from investigation that help implementation
understand the landscape:

**Existing patterns:**
- How do similar components work in this codebase?
- What conventions should we follow?
- Reference files that demonstrate the pattern

**System architecture:**
- Where does this fit in the flow?
- What comes before/after?
- Sequence diagrams or state machine position

**Key constraints:**
- Performance limits (e.g., "4000 partition max per query")
- Business rules (e.g., "only DAY partitions supported initially")
- Technical limitations (e.g., "6 hour query timeout")

**Design decisions already made:**
- Why this approach over alternatives?
- What was discussed/decided during planning?

### 3. Progress Rules

Every plan must include a short progress tracking section
near the top, right after context. This travels with the
plan file so any agent picking it up in a fresh session
knows the rules without loading external skills:

```markdown
## Progress

Steps use checkboxes. Find the first unchecked step;
that's where to start. After completing a step, check it
off and commit the plan file update with the implementation
work. Do not start the next step until the current one is
checked off.
```

This section is short and imperative. It is not a
suggestion; it is a standing order embedded in the
document itself.

### 4. PR Breakdown

Break work into logical, independently reviewable units.
No standard structure; let the work guide the split.

For each PR:

```markdown
**PR N: [Purpose in 3-5 words]**

**What it does:** One paragraph explaining this PR's scope

**Why separate:** Why this is its own PR (if not obvious)

**Dependencies:** What must exist before this PR (other PRs, merged work)

**Files:** New files and modified files
```

### 5. Interfaces (Per PR or Component)

Define what's publicly exposed and how it's called:

**Method signatures with types:**
```markdown
Chunker.call(attempt: RedactionAttempt, partition_ids: Array<String> | nil) → Array<Hash>
```

**What it returns:**
```markdown
Returns array of chunk hashes:
[
  { partition_ids: ["2025-01-01", "2025-01-02"], byte_size: 50000000, row_count: 100000 },
  { partition_ids: ["2025-01-03"], byte_size: 80000000, row_count: 150000 }
]
```

**Integration points:**
```markdown
Called by: ChunkerJob (from state machine hook)
Calls: BigQuery INFORMATION_SCHEMA query
Side effects: None (pure function - returns data, doesn't mutate state)
```

### 6. Data Structures

Describe what flows through the system:

**Format and fields:**
```markdown
Chunk Hash:
- partition_ids: Array of partition identifier strings (YYYY-MM-DD format)
- byte_size: Total logical bytes across partitions (Integer)
- row_count: Total rows across partitions (Integer)
```

**Why this structure:**
```markdown
Passed through state transition to DMLQueryRunner.
Needs partition list for filtering, size data for monitoring.
Hash (not object) because state machines serialize to JSON.
```

**Transformations:**
```markdown
Input: INFORMATION_SCHEMA returns partition_id as "YYYYMMDD"
Processing: Convert to Date, format as YYYY-MM-DD (iso8601)
Output: Array of YYYY-MM-DD strings
```

### 7. Test Scenarios (Per PR)

List behaviours to verify, high level, not full test code.
This is a coverage checklist, not a TDD implementation
sequence. Use flat bullets; don't group by happy path vs.
edge case vs. error. The implementer decides the TDD order
during implementation (see `code-tdd-guide`).

```markdown
- No partition_ids (nil) → returns single chunk representing whole table
- Empty partition_ids array → same as nil
- Groups small partitions into single chunk when under limits
- Returns chunk with correct partition_ids, byte_size, row_count
- Splits into multiple chunks when partition count exceeds 4000
- Splits when accumulated bytes exceed MAX_BYTES_PER_CHUNK
- BigQuery connection error → raises with context
```

During TDD, more scenarios will emerge. This is the starting
point.

### 8. Open Questions

Mark unknowns to resolve during implementation:

```markdown
- Should we sort partitions by size before grouping?
- What if INFORMATION_SCHEMA returns null for byte_size?
- Do we need to handle partition_id format variations?
```

Don't guess answers; flag them for implementation to discover.

## Separation of Concerns Pattern

**Common pattern (not prescriptive):**

**Service layer** (pure business logic):
- Takes inputs (primitives or models)
- Returns data
- No state machine transitions
- Example: `Chunker.call` returns chunks array

**Integration layer** (wiring):
- Calls service
- Handles state transitions with service results
- Triggered by state machine hooks
- Example: `ChunkerJob` calls service, then `attempt.prepare_redaction!(chunks)`

This separation makes services testable without full state machine setup.

## What NOT to Include

### ❌ Complete Implementation Code

Don't write the full class/method body:

**Bad:**
```ruby
def call
  chunks = []
  current_chunk = []
  partition_info.each do |partition|
    # ... 30 more lines
```

**Good:**
```markdown
Groups partitions using bin-packing algorithm.
Respects MAX_PARTITIONS (4000) and MAX_BYTES (100GB) limits.
```

### ❌ Complete Test Code

Don't write assertions and setup:

**Bad:**
```ruby
test "groups partitions" do
  partition_ids = ["2025-01-01", "2025-01-02"]
  result = Chunker.call(attempt:, partition_ids:)
  assert_equal 1, result.size
end
```

**Good:**
```markdown
- Groups multiple small partitions into single chunk
```

### ❌ Step-by-Step Instructions

**Bad:**
```markdown
1. Loop through partition_ids
2. Query INFORMATION_SCHEMA for each
3. Create hash with results
4. Return array
```

**Good:**
```markdown
Query INFORMATION_SCHEMA once with all partition_ids.
Map results to chunk hashes.
```

## Example Plan Section

```markdown
## PR 2: Chunker Service

**What it does:** Queries BigQuery partition sizes and groups
them into optimized chunks for DML execution.

**Why separate:** Core business logic independent of state
machine. Easier to test and understand.

**Dependencies:** None (queries BQ directly)

**Interface:**

Chunker.call(attempt: RedactionAttempt, partition_ids: Array<String> | nil) → Array<Hash>

Parameters:
- attempt: RedactionAttempt with table info and watermarks
- partition_ids: Array of YYYY-MM-DD strings or nil for unpartitioned

Returns: Array of chunk hashes (see Data Structures below)

Integration:
- Called by: ChunkerJob
- Calls: BigQuery INFORMATION_SCHEMA.PARTITIONS
- Side effects: None (pure function)

**Data Structures:**

Chunk Hash:
- partition_ids: Array<String> - partitions in this chunk
- byte_size: Integer - total bytes
- row_count: Integer - total rows

Constraints:
- Max 4000 partition_ids per chunk (BQ DML limit)
- Max 100GB byte_size per chunk (6hr query estimate)

**Test Scenarios:**

- No partition_ids (nil) → single chunk with empty partition_ids
- Single partition → one chunk with metadata
- Multiple small partitions → grouped into one chunk
- >4000 partitions → split into multiple chunks
- Accumulated bytes >100GB → split into multiple chunks
- INFORMATION_SCHEMA query fails → raise with context
```

## Cleanup Section

When the plan was created with worktrees (the `repos`
parameter was provided during activation), include a cleanup
section at the end of the plan. List each worktree:

```markdown
## Cleanup

After the work is merged or abandoned:
- [ ] Remove worktree: `git worktree remove <worktree-path>`
- [ ] Delete branch: `git branch -D <branch>`
```

The worktree paths are reported during activation. Replace
`<branch>` with whatever branch was created during
implementation.

## When to Use This Skill

Use during `plan_mode` when:
- Planning code implementation
- Structuring multi-PR work
- About to write a development plan

Work with `planning-guide` for overall planning process.
Use `planning-dev-format` for content structure.
