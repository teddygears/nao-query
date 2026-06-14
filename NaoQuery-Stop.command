#!/bin/bash
# Stop nao-query (kills whatever is on :5050)
pids=$(lsof -iTCP:5050 -sTCP:LISTEN -t 2>/dev/null || true)
if [ -z "$pids" ]; then
  echo "nao-query is not running."
else
  echo "Stopping PID(s): $pids"
  kill $pids
  echo "Stopped."
fi
read -n 1 -s -r -p "Press any key to close…"
