---
name: dev-planning
description: >
  Development work planning methodology. How to structure plans for
  code implementation without writing the implementation itself.
  Focus on context, interfaces, data flow, and behaviors. Use during
  plan_mode when code work is involved.
---

# Development Planning

## Core Principle

**Plans provide context and direction, not implementation.**

Plans explain WHAT to build and WHY. Implementation (via TDD)
determines HOW. The plan should give enough context that
implementation can make intelligent decisions.

## Essential Plan Sections

### 1. Context from Research

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

### 2. PR Breakdown

Break work into logical, independently reviewable units.
No standard structure - let the work guide the split.

For each PR:

```markdown
**PR N: [Purpose in 3-5 words]**

**What it does:** One paragraph explaining this PR's scope

**Why separate:** Why this is its own PR (if not obvious)

**Dependencies:** What must exist before this PR (other PRs, merged work)

**Files:** New files and modified files
```

### 3. Interfaces (Per PR or Component)

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

### 4. Data Structures

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

### 5. Test Scenarios (Per PR)

List behaviors to verify - high level, not full test code:

```markdown
**Happy path:**
- Groups small partitions into single chunk when under limits
- Returns chunk with correct partition_ids, byte_size, row_count

**Edge cases:**
- No partition_ids (nil) → returns single chunk representing whole table
- Empty partition_ids array → same as nil

**Constraint enforcement:**
- Splits into multiple chunks when partition count exceeds 4000
- Splits when accumulated bytes exceed MAX_BYTES_PER_CHUNK

**Error handling:**
- BigQuery connection error → raises with context
```

During TDD, more scenarios will emerge. This is the starting point.

### 6. Open Questions

Mark unknowns to resolve during implementation:

```markdown
- Should we sort partitions by size before grouping?
- What if INFORMATION_SCHEMA returns null for byte_size?
- Do we need to handle partition_id format variations?
```

Don't guess answers - flag them for implementation to discover.

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

Happy path:
- No partition_ids (nil) → single chunk with empty partition_ids
- Single partition → one chunk with metadata
- Multiple small partitions → grouped into one chunk

Constraint enforcement:
- >4000 partitions → split into multiple chunks
- Accumulated bytes >100GB → split into multiple chunks

Error handling:
- INFORMATION_SCHEMA query fails → raise with context
```

## Reference TDD Workflow

Don't rewrite TDD process in plans. Just reference it:

```markdown
Follow TDD workflow (see tdd-workflow skill) for implementation.
```

Implementation knows to do RED → GREEN → REFACTOR cycles.

## When to Use This Skill

Use during `plan_mode` when:
- Planning code implementation
- Structuring multi-PR work
- About to write a development plan

Work with `plan-workflow` for overall planning process.
Use `dev-planning` for content structure.
