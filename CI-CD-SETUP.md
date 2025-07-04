# CI/CD Setup Guide

This guide explains how to set up continuous integration and deployment for the JPEG2AVIF service using GitHub Actions and Kubernetes.

## Overview

The CI/CD pipeline will:
1. Build a Docker image on every push to main branch
2. Push the image to GitHub Container Registry (GHCR)
3. Deploy the updated service to Kubernetes in the `webapps` namespace
4. Ensure the service always pulls the latest image

## Prerequisites

1. **Kubernetes cluster** with `kubectl` configured
2. **GitHub Personal Access Token** with `read:packages` permission
3. **Docker registry access** (GHCR automatically available)
4. **Ingress controller** (nginx recommended) for external access

## Required GitHub Repository Secrets

You need to create **ONE** repository secret:

### 1. KUBE_CONFIG
- **Description**: Base64-encoded Kubernetes config file
- **How to get**:
  ```bash
  # Get your current kubectl config
  cat ~/.kube/config | base64 -w 0
  ```
- **Value**: The base64-encoded output from the command above

### Setting up GitHub Secrets

1. Go to your GitHub repository: `https://github.com/ekskog/jpeg2avi-js`
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Create the secret:
   - Name: `KUBE_CONFIG`
   - Value: Your base64-encoded kubectl config

## Initial Kubernetes Setup

Before the GitHub Actions can deploy, you need to set up the initial Kubernetes resources:

1. **Run the setup script**:
   ```bash
   ./setup-kubernetes.sh
   ```

2. **Or manually create resources**:
   ```bash
   # Create namespace
   kubectl create namespace webapps

   # Create GHCR secret (replace with your GitHub token)
   kubectl create secret docker-registry ghcr-secret \
     --docker-server=ghcr.io \
     --docker-username=ekskog \
     --docker-password=YOUR_GITHUB_TOKEN \
     --docker-email=ekskog@users.noreply.github.com \
     --namespace=webapps

   # Deploy the application
   kubectl apply -f k8s-deployment-ghcr.yaml
   ```

## GitHub Actions Workflow

The workflow (`.github/workflows/build-and-deploy.yml`) will:

1. **Build Phase**:
   - Checkout code
   - Set up Docker Buildx
   - Log in to GHCR using `GITHUB_TOKEN` (automatic)
   - Build and push Docker image with multiple tags

2. **Deploy Phase**:
   - Set up kubectl
   - Configure cluster access using `KUBE_CONFIG` secret
   - Update deployment with new image
   - Wait for rollout completion
   - Verify deployment status

## Image Tags

The workflow creates multiple image tags:
- `ghcr.io/ekskog/jpeg2avif-js:latest` (main branch)
- `ghcr.io/ekskog/jpeg2avif-js:main-<commit-sha>` (specific commit)
- `ghcr.io/ekskog/jpeg2avif-js:pr-<number>` (pull requests)

## Kubernetes Resources

The deployment creates:
- **Deployment**: 2 replicas with health checks and resource limits
- **Service**: ClusterIP service exposing port 80
- **Ingress**: External access (configure your domain)

## Monitoring

After deployment, check the status:

```bash
# Check pods
kubectl get pods -n webapps -l app=jpeg2avif-js

# Check service
kubectl get service -n webapps jpeg2avif-js-service

# Check logs
kubectl logs -n webapps -l app=jpeg2avif-js --tail=50

# Check deployment status
kubectl rollout status deployment/jpeg2avif-js-deployment -n webapps
```

## Troubleshooting

### Common Issues

1. **Image pull errors**:
   - Check if GHCR secret is created correctly
   - Verify GitHub token has `read:packages` permission

2. **Deployment failures**:
   - Check if namespace exists
   - Verify resource limits are appropriate for your cluster

3. **GitHub Actions failures**:
   - Ensure `KUBE_CONFIG` secret is valid and base64-encoded
   - Check cluster connectivity

### Useful Commands

```bash
# Force deployment rollout
kubectl rollout restart deployment/jpeg2avif-js-deployment -n webapps

# Scale deployment
kubectl scale deployment jpeg2avif-js-deployment --replicas=3 -n webapps

# Delete and recreate deployment
kubectl delete -f k8s-deployment-ghcr.yaml
kubectl apply -f k8s-deployment-ghcr.yaml
```

## Security Notes

- The `GITHUB_TOKEN` is automatically provided by GitHub Actions
- Keep your `KUBE_CONFIG` secret secure and rotate it regularly
- Use resource limits to prevent resource exhaustion
- Consider using a dedicated service account for GitHub Actions

## Next Steps

1. Configure your domain in the Ingress resource
2. Set up monitoring and alerting
3. Consider implementing staging environments
4. Add database persistence if needed
