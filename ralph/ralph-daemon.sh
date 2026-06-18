#!/bin/bash

# Configuration
COMMAND="./ralph/ralph.sh --tool gemini 15"
INTERVAL_HOURS=6
INTERVAL_SECONDS=$((INTERVAL_HOURS * 3600))

# Spinner animation characters
SPINNER="/-\|"

while true; do
    echo "------------------------------------------------"
    echo "🚀 Starting Ralph: $(date)"
    echo "------------------------------------------------"
    
    # Run the actual command
    $COMMAND
    
    echo "✅ Execution finished. Next run in $INTERVAL_HOURS hours."
    
    # Countdown loop
    for ((i=$INTERVAL_SECONDS; i>0; i--)); do
        # Calculate hours, minutes, and seconds for the countdown display
        printf "\r[%c] Next run in: %02d:%02d:%02d " \
            "${SPINNER:i%4:1}" \
            $((i/3600)) \
            $(( (i%3600)/60 )) \
            $((i%60))
            
        sleep 1
    done
    
    echo -e "\n🔄 Restarting loop..."
done
