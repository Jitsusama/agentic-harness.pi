# Google Workspace Guide

Teaches the LLM how to use the `google` tool to access Gmail,
Calendar, Drive, Docs, Sheets and Slides.

## For Users

This skill enables natural language access to your Google
Workspace:

- "Find emails from Alice about the budget"
- "What's on my calendar tomorrow?"
- "Open that Google Doc"
- "Search Drive for quarterly reports"

## Authentication

Run `google-auth` once to authenticate. It supports multiple
accounts.

## What the LLM Learns

- Gmail search operators and patterns
- Calendar date handling
- How to paginate through results
- How to drill down (search → get details)
- Response structure (markdown + structured details)

See `SKILL.md` for the full guide loaded by Pi.
