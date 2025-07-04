#!/bin/bash

# JPEG to AVIF Conversion Service Test Script
# This script tests the conversion service by uploading a JPEG and saving both variants

set -e  # Exit on any error

# Configuration
SERVICE_URL="http://localhost:3000"
CONVERT_ENDPOINT="/convert"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Function to check if service is running
check_service() {
    print_status "Checking if service is running..."
    if curl -s "${SERVICE_URL}/health" > /dev/null 2>&1; then
        print_success "Service is running at ${SERVICE_URL}"
        return 0
    else
        print_error "Service is not running at ${SERVICE_URL}"
        print_error "Please start the service first: npm start"
        return 1
    fi
}

# Function to validate file
validate_file() {
    local file_path="$1"
    
    # Check if file exists
    if [[ ! -f "$file_path" ]]; then
        print_error "File does not exist: $file_path"
        return 1
    fi
    
    # Check file size (50MB limit)
    local file_size=$(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path" 2>/dev/null)
    local max_size=$((50 * 1024 * 1024))  # 50MB in bytes
    
    if [[ $file_size -gt $max_size ]]; then
        print_error "File is too large: $(($file_size / 1024 / 1024))MB (max: 50MB)"
        return 1
    fi
    
    # Check if it's a JPEG file by extension
    local extension="${file_path##*.}"
    if [[ ! "$extension" =~ ^(jpg|jpeg|JPG|JPEG)$ ]]; then
        print_warning "File extension is not jpg/jpeg: $extension"
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            return 1
        fi
    fi
    
    return 0
}

# Function to get file info
get_file_info() {
    local file_path="$1"
    local file_size=$(stat -f%z "$file_path" 2>/dev/null || stat -c%s "$file_path" 2>/dev/null)
    local file_size_mb=$(echo "scale=2; $file_size / 1024 / 1024" | bc)
    
    print_status "File: $(basename "$file_path")"
    print_status "Size: ${file_size_mb}MB (${file_size} bytes)"
}

# Function to decode base64 and save file
save_base64_file() {
    local base64_data="$1"
    local output_file="$2"
    
    # Decode base64 and save to file
    echo "$base64_data" | base64 -d > "$output_file"
    
    if [[ $? -eq 0 ]]; then
        local file_size=$(stat -f%z "$output_file" 2>/dev/null || stat -c%s "$output_file" 2>/dev/null)
        local file_size_kb=$(echo "scale=2; $file_size / 1024" | bc)
        print_success "Saved: $output_file (${file_size_kb}KB)"
    else
        print_error "Failed to save: $output_file"
    fi
}

# Function to format file size
format_file_size() {
    local size_bytes=$1
    if [[ $size_bytes -lt 1024 ]]; then
        echo "${size_bytes}B"
    elif [[ $size_bytes -lt 1048576 ]]; then
        echo "$(echo "scale=2; $size_bytes / 1024" | bc)KB"
    else
        echo "$(echo "scale=2; $size_bytes / 1024 / 1024" | bc)MB"
    fi
}

# Main function
main() {
    echo "================================================="
    echo "JPEG to AVIF Conversion Service Test"
    echo "================================================="
    echo
    
    # Check if service is running
    if ! check_service; then
        exit 1
    fi
    echo
    
    # Prompt for JPEG file
    while true; do
        read -p "Enter path to JPEG file (or 'quit' to exit): " file_path
        
        if [[ "$file_path" == "quit" ]]; then
            print_status "Goodbye!"
            exit 0
        fi
        
        # Expand tilde to home directory
        file_path="${file_path/#\~/$HOME}"
        
        if validate_file "$file_path"; then
            break
        fi
        echo
    done
    
    echo
    get_file_info "$file_path"
    echo
    
    # Prepare output directory (same as input file)
    local input_dir=$(dirname "$file_path")
    local input_filename=$(basename "$file_path")
    local input_name="${input_filename%.*}"
    
    local thumbnail_file="${input_dir}/${input_name}_thumb.avif"
    local fullsize_file="${input_dir}/${input_name}.avif"
    
    print_status "Output directory: $input_dir"
    print_status "Thumbnail will be saved as: $(basename "$thumbnail_file")"
    print_status "Full-size will be saved as: $(basename "$fullsize_file")"
    echo
    
    # Create temporary file for response
    local temp_response=$(mktemp)
    
    # Make the request
    print_status "Uploading and converting image..."
    local start_time=$(date +%s)
    
    local http_code=$(curl -s -w "%{http_code}" \
        -X POST \
        -F "image=@${file_path}" \
        "${SERVICE_URL}${CONVERT_ENDPOINT}" \
        -o "$temp_response")
    
    local end_time=$(date +%s)
    local total_time=$((end_time - start_time))
    
    echo
    
    # Check HTTP response code
    if [[ "$http_code" != "200" ]]; then
        print_error "HTTP Error: $http_code"
        if [[ -f "$temp_response" ]]; then
            print_error "Response: $(cat "$temp_response")"
        fi
        rm -f "$temp_response"
        exit 1
    fi
    
    # Parse JSON response
    if ! command -v jq &> /dev/null; then
        print_error "jq is not installed. Please install jq to parse JSON responses."
        print_status "Response saved to: $temp_response"
        exit 1
    fi
    
    # Check if conversion was successful
    local success=$(jq -r '.success' "$temp_response")
    if [[ "$success" != "true" ]]; then
        print_error "Conversion failed:"
        jq -r '.error' "$temp_response"
        rm -f "$temp_response"
        exit 1
    fi
    
    # Extract data from response
    local request_id=$(jq -r '.requestId' "$temp_response")
    local processing_time=$(jq -r '.processingTime' "$temp_response")
    local original_size=$(jq -r '.originalSize' "$temp_response")
    local thumbnail_data=$(jq -r '.thumbnail.data' "$temp_response")
    local thumbnail_size=$(jq -r '.thumbnail.size' "$temp_response")
    local fullsize_data=$(jq -r '.fullSize.data' "$temp_response")
    local fullsize_size=$(jq -r '.fullSize.size' "$temp_response")
    local memory_before=$(jq -r '.memoryUsage.before.heapUsed' "$temp_response")
    local memory_after=$(jq -r '.memoryUsage.after.heapUsed' "$temp_response")
    
    print_success "Conversion completed successfully!"
    echo
    print_status "Request ID: $request_id"
    print_status "Processing time: ${processing_time}ms (Total: ${total_time}s)"
    print_status "Memory usage: ${memory_before}MB → ${memory_after}MB"
    echo
    
    # Save files
    print_status "Saving converted files..."
    save_base64_file "$thumbnail_data" "$thumbnail_file"
    save_base64_file "$fullsize_data" "$fullsize_file"
    echo
    
    # Show compression statistics
    print_status "Compression Statistics:"
    local thumbnail_compression=$(echo "scale=1; (1 - $thumbnail_size / $original_size) * 100" | bc)
    local fullsize_compression=$(echo "scale=1; (1 - $fullsize_size / $original_size) * 100" | bc)
    
    echo "  Original:  $(format_file_size $original_size)"
    echo "  Thumbnail: $(format_file_size $thumbnail_size) (${thumbnail_compression}% compression)"
    echo "  Full-size: $(format_file_size $fullsize_size) (${fullsize_compression}% compression)"
    echo
    
    print_success "Test completed successfully!"
    print_status "Files saved in: $input_dir"
    
    # Clean up
    rm -f "$temp_response"
}

# Check dependencies
if ! command -v curl &> /dev/null; then
    print_error "curl is required but not installed."
    exit 1
fi

if ! command -v bc &> /dev/null; then
    print_error "bc is required but not installed."
    exit 1
fi

# Run main function
main "$@"
