#!/bin/bash
# Batch apply to Upwork jobs one at a time, waiting for each to complete.
# Usage: ./scripts/batch-apply.sh

API="http://localhost:8051"
MAX_WAIT=120  # seconds to wait per job

JOBS=(
  "022028572214204514865"
  "022028578456717181489"
  "022028564631060002609"
  "022028569878899933745"
  "022028560661472399380"
  "022028484032504837937"
  "022028517219379659313"
  "022028507259732181553"
  "022028454924209341890"
  "022028468735028205404"
  "022028541156925152229"
)

TOTAL=${#JOBS[@]}
SUCCESS=0
FAILED=0
SKIPPED=0

echo "=== Batch Upwork Apply: $TOTAL jobs ==="
echo ""

for i in "${!JOBS[@]}"; do
  uid="${JOBS[$i]}"
  idx=$((i + 1))

  # Get job title
  TITLE=$(curl -s "$API/api/upwork/jobs" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    if j['uid'] == '$uid':
        print(j['title'][:60])
        break
else:
    print('Unknown')
" 2>/dev/null)

  echo "[$idx/$TOTAL] $TITLE"
  echo "  UID: $uid"

  # Submit
  RESULT=$(curl -s -X POST "$API/api/upwork/apply" \
    -H "Content-Type: application/json" \
    -d "{\"uid\": \"$uid\", \"dryRun\": false}" 2>&1)

  echo "  API response: $RESULT"

  # Check if submission was accepted
  OK=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
  if [ "$OK" != "True" ]; then
    echo "  SKIPPED: API rejected the request"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Poll until status changes from proposal_ready/submitting
  echo -n "  Waiting for completion"
  ELAPSED=0
  FINAL_STATUS=""
  while [ $ELAPSED -lt $MAX_WAIT ]; do
    sleep 5
    ELAPSED=$((ELAPSED + 5))
    echo -n "."

    STATUS=$(curl -s "$API/api/upwork/jobs" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    if j['uid'] == '$uid':
        print(j['status'])
        break
else:
    # Check if it moved to applied (not in pending jobs anymore)
    print('not_found')
" 2>/dev/null)

    if [ "$STATUS" = "applied" ]; then
      FINAL_STATUS="applied"
      break
    elif [ "$STATUS" = "submit_failed" ] || [ "$STATUS" = "expired" ]; then
      FINAL_STATUS="$STATUS"
      break
    elif [ "$STATUS" = "not_found" ]; then
      # May have been applied and moved to applied list
      FINAL_STATUS="check_applied"
      break
    fi
    # Still submitting/proposal_ready — keep waiting
  done
  echo ""

  if [ -z "$FINAL_STATUS" ]; then
    FINAL_STATUS="timeout"
  fi

  # If not_found in jobs list, check applied list
  if [ "$FINAL_STATUS" = "check_applied" ]; then
    APPLIED=$(curl -s "$API/api/upwork/applied" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for j in data.get('jobs', []):
    if j.get('uid') == '$uid':
        print('applied')
        break
else:
    print('unknown')
" 2>/dev/null)
    FINAL_STATUS="$APPLIED"
  fi

  case "$FINAL_STATUS" in
    applied)
      echo "  ✓ APPLIED"
      SUCCESS=$((SUCCESS + 1))
      ;;
    submit_failed|expired)
      # Get failure reason
      REASON=$(sqlite3 /Users/claude/projects/infra/project-orchestrator/orchestrator.db \
        "SELECT substr(filter_reason,1,80) FROM upwork_jobs WHERE uid='$uid';" 2>/dev/null)
      echo "  ✗ FAILED: $REASON"
      FAILED=$((FAILED + 1))
      ;;
    timeout)
      echo "  ⏳ TIMEOUT (may still be processing)"
      FAILED=$((FAILED + 1))
      ;;
    *)
      echo "  ? STATUS: $FINAL_STATUS"
      FAILED=$((FAILED + 1))
      ;;
  esac
  echo ""
done

echo "================================"
echo "Results: $SUCCESS applied, $FAILED failed, $SKIPPED skipped (of $TOTAL)"
echo "================================"
