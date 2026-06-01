# Convention Recurrence Sensor Guide

Teaches the agent how to measure whether convention corrections
keep recurring in the pi session logs, by category and by week.

Activates when recording a baseline before the convention gates
take effect, or re-running afterwards to confirm the recurring
categories bend down.

Pairs with the convention gates (pr-guardian, issue-guardian,
commit-guardian, slack-integration) and the convention-context
extension. The runnable sensor lives at
[`scripts/convention-recurrence.ts`](../../scripts/convention-recurrence.ts).
