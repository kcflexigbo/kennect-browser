#!/bin/zsh
SCRIPT_DIR="${0:A:h}"
if [[ -f "$SCRIPT_DIR/install/runtime.txt" ]]; then
 NODE_BIN="$(/bin/cat "$SCRIPT_DIR/install/runtime.txt")"
 "$NODE_BIN" "$SCRIPT_DIR/start.mjs"
else
 node "$SCRIPT_DIR/start.mjs"
fi
