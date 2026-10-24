#!/bin/sh
# Test double for the `codex` CLI. Behaviour is chosen by the first line of the prompt on stdin.
# Reads stdin; prints Codex-style JSONL events like `codex exec --json`.
PROMPT=$(cat)
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"turn.started"}'
case "$PROMPT" in
  *LIMIT*)
    echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Partial text before the limit."}}'
    echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again later."}}'
    exit 1 ;;
  *NOTHING*)
    echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit."}}'
    exit 1 ;;
esac
echo '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"ls -la","status":"completed"}}'
echo '{"type":"item.completed","item":{"id":"i3","type":"file_change","changes":[{"path":"'"$PWD"'/a.txt","kind":"update"}]}}'
echo '{"type":"item.completed","item":{"id":"i4","type":"agent_message","text":"Done: edited a.txt. ARGS-OK"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":30,"reasoning_output_tokens":0}}'
