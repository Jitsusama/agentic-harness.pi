# Ask Extension

A structured question tool the agent uses to gather input
during planning, investigation or any workflow that needs
clarification.

## How It Works

The agent calls the `ask` tool with one or more questions,
each with predefined options. You pick from the options or
type a free-form response. When there are multiple questions,
they're navigated via a tab bar.

A question can name a `recommended` option. You see it marked
as recommended. While you are away (see
[away-workflow](../away-workflow/)) nothing is asked: the
recommendation is taken, or the agent is told to decide from the
evidence and say what it chose, and every answer is listed for
you when you are back.

Any skill or extension can rely on this tool being available.
