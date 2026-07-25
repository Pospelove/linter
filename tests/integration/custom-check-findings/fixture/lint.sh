#!/bin/bash
if [ "$LINTER_MODE" == "lint" ]; then
  echo '[{"message": "Custom finding 1", "startLine": 1, "snippet": "line 1"}, {"message": "Custom finding 2", "startLine": 2, "snippet": "line 2"}]'
  exit 1
fi
exit 0
