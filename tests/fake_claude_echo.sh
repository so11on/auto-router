#!/bin/sh
# Test double for `claude`: answers with its own arguments so tests can see which flags the bridge chose.
args=$(printf '%s ' "$@" | sed 's/"/ /g')
echo "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ARGS: $args\"}}}"
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'
