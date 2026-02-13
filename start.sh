#!/bin/bash
# Start the orchestrator in a persistent tmux session.
# This inherits your terminal's Full Disk Access for Messages.app.
#
# Usage:
#   ./start.sh          - start the orchestrator
#   ./start.sh stop     - stop the orchestrator
#   ./start.sh attach   - attach to see live logs
#   ./start.sh status   - check if running
#   ./start.sh restart  - restart the orchestrator

DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="orchestrator"

case "${1:-start}" in
  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Orchestrator already running. Use './start.sh attach' to view."
      exit 0
    fi

    tmux new-session -d -s "$SESSION" -c "$DIR" "node index.js"
    echo "Orchestrator started in tmux session '$SESSION'."
    echo ""
    echo "  View logs:  ./start.sh attach  (Ctrl-B D to detach)"
    echo "  Stop:       ./start.sh stop"
    echo "  Status:     ./start.sh status"
    echo ""
    echo "You can now close this terminal. The orchestrator keeps running."
    echo "Text 'status' to your bot to verify."
    ;;

  stop)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux send-keys -t "$SESSION" C-c
      sleep 1
      tmux kill-session -t "$SESSION" 2>/dev/null
      echo "Orchestrator stopped."
    else
      echo "Orchestrator not running."
    fi
    ;;

  attach)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      tmux attach -t "$SESSION"
    else
      echo "Orchestrator not running. Start it with ./start.sh"
    fi
    ;;

  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Orchestrator: RUNNING"
      tmux capture-pane -t "$SESSION" -p | tail -5
    else
      echo "Orchestrator: NOT RUNNING"
    fi
    ;;

  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;

  *)
    echo "Usage: $0 [start|stop|attach|status|restart]"
    ;;
esac
