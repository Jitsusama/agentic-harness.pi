# Spend

What the session spends and what is left of it, for `spend-workflow`
and the status line.

## Folders

- **`cost-meter/`**: what the status line says about money and
  context, shared by the extension that knows the figures and the
  widget that lays them out.

## Files

- **`claude-plan.ts`**: where a Claude plan's five-hour and weekly
  allowances stand, read from what the Claude Code provider says
  after each turn, for spend-workflow's budget item.
- **`resources.ts`**: the CPU, disk and memory this pi process and
  its work used, from the kernel's counters.
- **`spend-watch.ts`**: the bill for a period, asked of spend-watch's
  command line where it is installed, for the spend tool.
- **`spend-watch-budgets.ts`**: where every budget stands, its
  allowances in their own units, and the total across all AI spend,
  asked of `spend-watch budgets --json`, for the footer and `/budget`.
