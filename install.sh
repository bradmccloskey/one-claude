#!/bin/bash
# Install/uninstall the Project Orchestrator as a launchd service
# Usage: ./install.sh [install|uninstall|status|logs]

PLIST_NAME="com.claude.orchestrator"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.claude.orchestrator.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$(cd "$(dirname "$0")" && pwd)/logs"

case "${1:-install}" in
  install)
    echo "Installing Project Orchestrator service..."

    # Create logs directory
    mkdir -p "$LOG_DIR"

    # Install dependencies if needed
    if [ ! -d "$(dirname "$0")/node_modules" ]; then
      echo "Installing npm dependencies..."
      cd "$(dirname "$0")" && npm install
    fi

    # Copy plist to LaunchAgents
    cp "$PLIST_SRC" "$PLIST_DEST"
    echo "Installed plist to $PLIST_DEST"

    # Load the service
    launchctl load "$PLIST_DEST"
    echo "Service loaded and started."
    echo ""
    echo "The orchestrator will now:"
    echo "  - Start automatically on boot"
    echo "  - Restart if it crashes"
    echo "  - Send morning digests at 7am ET"
    echo "  - Respond to your iMessage commands"
    echo ""
    echo "View logs:  ./install.sh logs"
    echo "Status:     ./install.sh status"
    echo "Uninstall:  ./install.sh uninstall"
    ;;

  uninstall)
    echo "Uninstalling Project Orchestrator service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null
    rm -f "$PLIST_DEST"
    echo "Service stopped and uninstalled."
    ;;

  status)
    if launchctl list | grep -q "$PLIST_NAME"; then
      echo "Orchestrator: RUNNING"
      launchctl list "$PLIST_NAME"
    else
      echo "Orchestrator: NOT RUNNING"
    fi
    ;;

  logs)
    echo "=== Recent stdout ==="
    tail -30 "$LOG_DIR/stdout.log" 2>/dev/null || echo "(no logs yet)"
    echo ""
    echo "=== Recent stderr ==="
    tail -10 "$LOG_DIR/stderr.log" 2>/dev/null || echo "(no errors)"
    echo ""
    echo "Follow logs: tail -f $LOG_DIR/stdout.log"
    ;;

  *)
    echo "Usage: $0 [install|uninstall|status|logs]"
    exit 1
    ;;
esac
