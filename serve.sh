#!/bin/bash
# Simple script to serve the Stoplight game
echo "Starting web server on http://localhost:8000"
echo "Press Ctrl+C to stop"
echo ""
python3 -m http.server 8000
