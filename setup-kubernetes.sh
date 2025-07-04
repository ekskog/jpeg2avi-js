#!/bin/bash

# Kubernetes Setup Script for JPEG2AVIF Service
# This script helps set up the necessary Kubernetes resources

set -e

# Configuration
NAMESPACE="webapps"
IMAGE_REGISTRY="ghcr.io"
GITHUB_USER="ekskog"
REPO_NAME="jpeg2avif-js"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

# Function to check if kubectl is available
check_kubectl() {
    if ! command -v kubectl &> /dev/null; then
        print_error "kubectl is not installed or not in PATH"
        exit 1
    fi
    
    # Check if kubectl can connect to cluster
    if ! kubectl cluster-info &> /dev/null; then
        print_error "kubectl cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    print_success "kubectl is available and connected to cluster"
}

# Function to verify namespace exists
verify_namespace() {
    print_status "Verifying namespace exists: $NAMESPACE"
    
    if kubectl get namespace "$NAMESPACE" &> /dev/null; then
        print_success "Namespace '$NAMESPACE' exists"
    else
        print_error "Namespace '$NAMESPACE' does not exist"
        print_error "Please create the namespace first: kubectl create namespace $NAMESPACE"
        exit 1
    fi
}

# Function to create GitHub Container Registry secret
create_ghcr_secret() {
    print_status "Creating GitHub Container Registry secret..."
    
    echo "Please provide your GitHub Personal Access Token with 'read:packages' permission:"
    read -s GITHUB_TOKEN
    echo
    
    # Create the secret
    kubectl create secret docker-registry ghcr-secret \
        --docker-server="$IMAGE_REGISTRY" \
        --docker-username="$GITHUB_USER" \
        --docker-password="$GITHUB_TOKEN" \
        --docker-email="$GITHUB_USER@users.noreply.github.com" \
        --namespace="$NAMESPACE" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    print_success "Created GHCR secret in namespace: $NAMESPACE"
}

# Function to setup initial deployment (without deploying)
setup_deployment_config() {
    print_status "Setting up Kubernetes deployment configuration..."
    
    if [[ -f "k8s-deployment-ghcr.yaml" ]]; then
        print_success "Found k8s-deployment-ghcr.yaml"
        print_warning "Deployment will be created when you push code to GitHub"
        print_status "The GitHub Actions workflow will build the Docker image and deploy it"
    else
        print_error "k8s-deployment-ghcr.yaml not found"
        exit 1
    fi
}

# Function to show current deployment status (if any)
show_current_status() {
    print_status "Checking current deployment status..."
    
    # Check if deployment exists
    if kubectl get deployment jpeg2avif-js-deployment -n "$NAMESPACE" &> /dev/null; then
        print_status "Deployment exists. Current status:"
        echo
        
        print_status "Pods:"
        kubectl get pods -n "$NAMESPACE" -l app=jpeg2avif-js
        echo
        
        print_status "Services:"
        kubectl get services -n "$NAMESPACE" -l app=jpeg2avif-js
        echo
        
        print_status "Ingress:"
        kubectl get ingress -n "$NAMESPACE" -l app=jpeg2avif-js
        echo
        
        # Get service URL
        SERVICE_IP=$(kubectl get service jpeg2avif-js-service -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
        if [[ -n "$SERVICE_IP" ]]; then
            print_success "Service is available at: http://$SERVICE_IP"
        else
            print_status "Service is available through cluster IP (check ingress for external access)"
        fi
    else
        print_status "No deployment found yet"
        print_status "Deployment will be created when you push code to trigger GitHub Actions"
    fi
}

# Main function
main() {
    echo "================================================="
    echo "Kubernetes Setup for JPEG2AVIF Service"
    echo "================================================="
    echo
    
    check_kubectl
    verify_namespace
    create_ghcr_secret
    setup_deployment_config
    show_current_status
    
    echo
    print_success "Setup completed successfully!"
    print_status "GitHub Container Registry secret created in '$NAMESPACE' namespace"
    print_status "Next steps:"
    print_status "1. Push your code to GitHub to trigger the CI/CD pipeline"
    print_status "2. GitHub Actions will build the Docker image and deploy it"
    print_status "3. Monitor the deployment: kubectl get pods -n $NAMESPACE -l app=jpeg2avif-js"
}

# Run main function
main "$@"
