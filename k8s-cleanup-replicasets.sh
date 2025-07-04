#!/bin/bash

# Kubernetes ReplicaSet Cleanup Script
# This script cleans up old ReplicaSets for all deployments in the webapps namespace
# It keeps only the current active ReplicaSet and deletes all old ones (with 0 replicas)

set -e

NAMESPACE="webapps"
DRY_RUN=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -n, --namespace NAMESPACE  Kubernetes namespace (default: webapps)"
    echo "  -d, --dry-run             Show what would be deleted without actually deleting"
    echo "  -h, --help                Show this help message"
    echo ""
    echo "This script cleans up old ReplicaSets (with 0 replicas) for all deployments"
    echo "in the specified namespace, keeping only the current active ReplicaSets."
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    print_error "kubectl is not installed or not in PATH"
    exit 1
fi

# Check if namespace exists
if ! kubectl get namespace "$NAMESPACE" &> /dev/null; then
    print_error "Namespace '$NAMESPACE' does not exist"
    exit 1
fi

print_info "Starting ReplicaSet cleanup for namespace: $NAMESPACE"
if [[ "$DRY_RUN" == "true" ]]; then
    print_warning "DRY RUN MODE - No actual deletions will be performed"
fi

# Get all deployments in the namespace
print_info "Getting all deployments in namespace '$NAMESPACE'..."
DEPLOYMENTS=$(kubectl get deployments -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}')

if [[ -z "$DEPLOYMENTS" ]]; then
    print_warning "No deployments found in namespace '$NAMESPACE'"
    exit 0
fi

print_info "Found deployments: $DEPLOYMENTS"
echo ""

# Initialize counters
TOTAL_OLD_RS=0
TOTAL_DELETED=0

# Process each deployment
for DEPLOYMENT in $DEPLOYMENTS; do
    print_info "Processing deployment: $DEPLOYMENT"
    
    # Get all ReplicaSets for this deployment
    RS_LIST=$(kubectl get replicasets -n "$NAMESPACE" -l "app=$(kubectl get deployment "$DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.metadata.labels.app}')" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")
    
    if [[ -z "$RS_LIST" ]]; then
        print_warning "No ReplicaSets found for deployment $DEPLOYMENT"
        continue
    fi
    
    # Get old ReplicaSets (with 0 desired replicas)
    OLD_RS=""
    for RS in $RS_LIST; do
        DESIRED=$(kubectl get replicaset "$RS" -n "$NAMESPACE" -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
        CURRENT=$(kubectl get replicaset "$RS" -n "$NAMESPACE" -o jsonpath='{.status.replicas}' 2>/dev/null || echo "0")
        
        if [[ "$DESIRED" == "0" && "$CURRENT" == "0" ]]; then
            OLD_RS="$OLD_RS $RS"
        fi
    done
    
    if [[ -z "$OLD_RS" ]]; then
        print_success "No old ReplicaSets found for deployment $DEPLOYMENT"
        continue
    fi
    
    # Count and show old ReplicaSets
    OLD_RS_COUNT=$(echo $OLD_RS | wc -w)
    TOTAL_OLD_RS=$((TOTAL_OLD_RS + OLD_RS_COUNT))
    
    print_warning "Found $OLD_RS_COUNT old ReplicaSet(s) for deployment $DEPLOYMENT:"
    for RS in $OLD_RS; do
        AGE=$(kubectl get replicaset "$RS" -n "$NAMESPACE" -o jsonpath='{.metadata.creationTimestamp}' 2>/dev/null || echo "unknown")
        echo "  - $RS (created: $AGE)"
    done
    
    # Delete old ReplicaSets
    if [[ "$DRY_RUN" == "true" ]]; then
        print_info "DRY RUN: Would delete $OLD_RS_COUNT ReplicaSet(s) for $DEPLOYMENT"
    else
        print_info "Deleting $OLD_RS_COUNT old ReplicaSet(s) for $DEPLOYMENT..."
        for RS in $OLD_RS; do
            if kubectl delete replicaset "$RS" -n "$NAMESPACE" 2>/dev/null; then
                print_success "Deleted ReplicaSet: $RS"
                TOTAL_DELETED=$((TOTAL_DELETED + 1))
            else
                print_error "Failed to delete ReplicaSet: $RS"
            fi
        done
    fi
    
    echo ""
done

# Summary
echo "=================================================="
print_info "CLEANUP SUMMARY"
echo "=================================================="
print_info "Namespace: $NAMESPACE"
print_info "Total old ReplicaSets found: $TOTAL_OLD_RS"

if [[ "$DRY_RUN" == "true" ]]; then
    print_warning "DRY RUN: Would have deleted $TOTAL_OLD_RS ReplicaSet(s)"
    print_info "Run without --dry-run to perform actual cleanup"
else
    print_success "Total ReplicaSets deleted: $TOTAL_DELETED"
    if [[ $TOTAL_DELETED -lt $TOTAL_OLD_RS ]]; then
        print_warning "Some ReplicaSets could not be deleted (see errors above)"
    fi
fi

echo ""
print_info "Cleanup completed!"

# Show current ReplicaSets status
print_info "Current ReplicaSets in namespace '$NAMESPACE':"
kubectl get replicasets -n "$NAMESPACE" -o wide
