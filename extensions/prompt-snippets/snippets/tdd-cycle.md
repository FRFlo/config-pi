---
name: TDD cycle
description: Write the failing test before implementation
placement: append
order: 25
---
Use test-driven development for behavior changes:
1. write a focused test that expresses the desired behavior and fails;
2. implement the smallest change that makes it pass;
3. run the focused test;
4. refactor only while keeping the tests green;
5. run the broader relevant test suite before reporting completion.
Do not weaken, remove, or skip a test merely to make it pass.
