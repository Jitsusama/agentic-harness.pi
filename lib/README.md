# Library

Reusable TypeScript code for Pi extensions. Other Pi packages
can add this repo as an npm dependency and import from the
public modules without loading any extensions or skills.

## Public Modules

Each public module has a barrel export (`index.ts`) that
defines the importable surface. Import from the barrel, not
from internal files.

- **[`guardian/`](guardian/)**: guardian contract,
  registration and redirect formatting. Everything a
  downstream package needs to build its own command guardians.
- **[`shell/`](shell/)**: shell command parsing, with flag
  extraction, heredoc stripping, compound command splitting
  and safe quoting.
- **[`ui/`](ui/)**: TUI primitives, being panels, prompts, content
  rendering, navigable lists and text layout.
- **[`slack/`](slack/)**: Slack API client, authentication,
  renderers and resolvers.
- **[`google/`](google/)**: Google Workspace API clients,
  authentication and renderers.
- **[`web/`](web/)**: web search and page reading via
  headless Chrome.
- **[`review/`](review/)**: pluggable review providers, being one
  neutral model for changes, stacks, diffs, anchors and
  conversation, with facet-based providers behind it, and
  drafts that compose a review before compiling it into what a
  given backend will accept. Also asking other models about a
  change (council, judge, critique, audit and a stack-wide
  round, under [`ask/`](review/ask/)) and authoring changes
  rather than only reading them, which asks the provider what
  it will accept before anything is sent.
- **[`work/`](work/)**: the working layer under a review,
  where a tree is cut from and what pins it, a broker holding
  the trees a session is using, and reading or writing the
  history inside one. A worktree is pinned to a branch and
  exclusive; a snapshot is pinned to a commit and shareable,
  which is what lets six reviewers of one commit share a
  single tree. Tree providers register over the event bus, so
  one can live in another package.
- **[`remote/`](remote/)**: naming a git remote to a person.
  A remote can carry a token as its user or as its password,
  so a refusal that names one verbatim prints a live secret.
  The credential comes out for display and stays in for the
  fetch, which needs it.
- **[`clock/`](clock/)**: what a duration bounding a child
  process may be. The rules belong to the runner, which is the
  last place they can be applied: by then a roster has been
  read, a change fetched and a tree cut, and the refusal
  arrives as a thrown error mid-round rather than as an answer
  about a config file. One definition, so a roster cannot
  accept a clock the runner will throw over.
- **[`subagent/`](subagent/)**: subagent engine for
  running pi as a child process: spec/job composition,
  fleet fan-out, durable supervisor runs, stream parsing,
  artifact recovery and the verify-pack protocol.

## Internal Modules

[`internal/`](internal/) contains code shared across
extensions in this package. Don't import from it in external
packages; it may change without notice.

The general-purpose guardian and shell parsing code was
promoted from `internal/guardian/` to the public `guardian/`
and `shell/` modules. The internal directory retains only
commit-specific parsing and the entity review helper.
