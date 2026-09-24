---
name: Behavior testing
description: Use meaningful E2E coverage and resist test shortcuts
placement: append
order: 35
---
Prefer E2E tests as the primary verification mechanism; use medium-to-hard realistic scenarios rather than the easiest happy path.
End E2E verification with a verifiable, repeatable artifact such as a report, screenshot, recording, or captured output.
For isolated tests, enumerate concrete failure modes first, then write tests that distinguish them. Reject tautological, self-testing, and change-detector tests.
Before adding tests, extend existing coverage where appropriate, combine trivial cases, avoid duplication, and add regression tests only for genuine behavior gaps.
