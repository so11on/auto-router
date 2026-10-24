#!/bin/sh
# Test double for the GitHub `copilot` CLI in programmatic mode: `copilot -p <prompt> -s [--model=X] [--allow-tool=...]`.
# Prints only the answer (like -s). Behaviour is chosen from the prompt text. Echoes which flags it received.
PROMPT="$2"
case "$*" in *"Read the file"*) PROMPT=$(cat "$(echo "$2" | sed -E 's/Read the file ([^ ]+) .*/\1/')") ;; esac
case "$PROMPT" in
  *PREMIUMLIMIT*) echo "You have reached your monthly premium request limit." >&2; exit 1 ;;
esac
echo "Copilot answer. FLAGS: $*" | sed -E 's/-p [^ ]+ //' | cut -c1-200
case "$PROMPT" in *EDITFILE*) echo "edited" > copilot-edit.txt ;; esac
