#!/bin/bash
# Usage: ./scripts/watch.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

echo "Press Ctrl+C to stop"
echo ""

# Check if files exist

# Use tail to follow both files
# -f = follow, shows new lines as they're added
