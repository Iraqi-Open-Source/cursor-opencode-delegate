# Plan in Cursor, implement lite steps with OpenCode

Task:

$ARGUMENTS

Steps:
1. Make a concise implementation plan. Label each step **LITE** or **HEAVY** (see the opencode-delegate rule).
2. Show me the plan briefly.
3. Delegate every LITE step to OpenCode with `opencode_delegate` (self-contained prompts; follow DELEGATION_MODE in the rule).
4. Implement HEAVY steps yourself.
5. Review all diffs, run tests/lint, and summarize what OpenCode did and what you did.
