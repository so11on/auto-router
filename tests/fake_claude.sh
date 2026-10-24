#!/bin/sh
# Test double for the `claude` CLI: writes some text, then dies like a plan-limit hit.
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial answer before the limit. "}}}'
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached"}'
exit 1
