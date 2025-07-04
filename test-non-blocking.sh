#!/bin/bash

# Test script for non-blocking JPEG to AVIF conversion service

SERVICE_URL=${1:-"http://localhost:3000"}
TEST_IMAGE=${2:-"test.jpg"}

echo "Testing non-blocking JPEG to AVIF conversion service at $SERVICE_URL"
echo "Using Redis at: ${REDIS_HOST:-cache.hbvu.su}"

# Check if test image exists
if [ ! -f "$TEST_IMAGE" ]; then
    echo "Error: Test image '$TEST_IMAGE' not found!"
    echo "Please provide a JPEG image as the second argument"
    exit 1
fi

echo "1. Testing health endpoint..."
curl -s "$SERVICE_URL/health" | jq .

echo -e "\n2. Uploading image for conversion..."
RESPONSE=$(curl -s -X POST \
  -F "image=@$TEST_IMAGE" \
  "$SERVICE_URL/convert")

echo "$RESPONSE" | jq .

# Extract job ID from response
JOB_ID=$(echo "$RESPONSE" | jq -r '.jobId')

if [ "$JOB_ID" = "null" ]; then
    echo "Error: Failed to get job ID from response"
    exit 1
fi

echo -e "\n3. Job ID: $JOB_ID"
echo "4. Checking job status..."

# Poll for job completion
for i in {1..30}; do
    echo "Attempt $i: Checking job status..."
    
    STATUS_RESPONSE=$(curl -s "$SERVICE_URL/status/$JOB_ID")
    STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
    
    echo "$STATUS_RESPONSE" | jq .
    
    if [ "$STATUS" = "completed" ]; then
        echo -e "\n✅ Job completed successfully!"
        
        # Extract and save results
        THUMB_DATA=$(echo "$STATUS_RESPONSE" | jq -r '.results.thumbnail.data')
        FULL_DATA=$(echo "$STATUS_RESPONSE" | jq -r '.results.fullSize.data')
        THUMB_FILENAME=$(echo "$STATUS_RESPONSE" | jq -r '.results.thumbnail.filename')
        FULL_FILENAME=$(echo "$STATUS_RESPONSE" | jq -r '.results.fullSize.filename')
        
        echo "Saving results..."
        echo "$THUMB_DATA" | base64 -d > "$THUMB_FILENAME"
        echo "$FULL_DATA" | base64 -d > "$FULL_FILENAME"
        
        echo "✅ Files saved: $THUMB_FILENAME, $FULL_FILENAME"
        break
    elif [ "$STATUS" = "failed" ]; then
        echo -e "\n❌ Job failed!"
        break
    elif [ "$STATUS" = "processing" ]; then
        echo "Job is processing..."
    else
        echo "Job status: $STATUS"
    fi
    
    sleep 2
done

echo -e "\nTest completed!"
