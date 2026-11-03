#!/usr/bin/env node
// PreToolUse hook (Bash): a plain test-runner command is rewritten so that only failures and the last lines reach the context.
// Passing runs cost a few lines instead of the whole log. The exit code is kept, so the agent still knows whether it passed.
// Anything that is not ONE simple test command (pipes, redirects, ;, &&, substitutions) is left alone: nothing is ever injected.
import fs from "node:fs";

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const cmd = (input.tool_input && input.tool_input.command) || "";
const RUNNERS = /^(npm test|npm run test|yarn test|pnpm test|pytest|python3? -m (unittest|pytest)|go test|cargo test|node --test|vitest|jest|bun test|make test|phpunit|mvn test|gradle test)( [A-Za-z0-9_./=:@%+,\-]+)*$/;
if (!RUNNERS.test(cmd.trim()) || process.env.AR_NO_FILTER) {
  console.log("{}");
} else {
  const filtered = `__o=$(${cmd.trim()} 2>&1); __rc=$?; printf '%s\\n' "$__o" | grep -A 5 -E 'FAIL|ERROR|error:|Error:|Traceback|not ok|panic|✘|✖' | head -120; ` +
    `printf -- '--- last lines ---\\n%s\\n--- exit code: %s ---\\n' "$(printf '%s\\n' "$__o" | tail -n 6)" "$__rc"; exit $__rc`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input.tool_input, command: filtered } } }));
}
