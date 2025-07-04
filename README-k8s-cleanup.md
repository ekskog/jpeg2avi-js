# Kubernetes ReplicaSet Cleanup

This directory contains scripts for cleaning up old ReplicaSets in Kubernetes clusters.

## Scripts

### `k8s-cleanup-replicasets.sh`

A comprehensive script that cleans up old ReplicaSets (with 0 replicas) for all deployments in a specified namespace.

#### Features

- **Multi-deployment support**: Automatically discovers and processes all deployments in a namespace
- **Safety checks**: Only deletes ReplicaSets with 0 desired and 0 current replicas
- **Dry-run mode**: Test what would be deleted before running the actual cleanup
- **Colored output**: Easy-to-read colored console output
- **Detailed logging**: Shows which ReplicaSets are being deleted with timestamps
- **Summary report**: Provides a summary of the cleanup operation

#### Usage

```bash
# Basic usage (cleans up webapps namespace)
./k8s-cleanup-replicasets.sh

# Specify a different namespace
./k8s-cleanup-replicasets.sh --namespace production

# Dry-run mode (shows what would be deleted)
./k8s-cleanup-replicasets.sh --dry-run

# Help
./k8s-cleanup-replicasets.sh --help
```

#### Options

- `-n, --namespace NAMESPACE`: Kubernetes namespace (default: webapps)
- `-d, --dry-run`: Show what would be deleted without actually deleting
- `-h, --help`: Show help message

#### Examples

```bash
# Clean up all old ReplicaSets in webapps namespace
./k8s-cleanup-replicasets.sh

# Clean up old ReplicaSets in production namespace with dry-run
./k8s-cleanup-replicasets.sh --namespace production --dry-run

# Clean up old ReplicaSets in staging namespace
./k8s-cleanup-replicasets.sh -n staging
```

## How it Works

1. **Discovery**: The script first discovers all deployments in the specified namespace
2. **Analysis**: For each deployment, it finds all associated ReplicaSets
3. **Filtering**: It identifies old ReplicaSets (those with 0 desired and 0 current replicas)
4. **Cleanup**: It deletes the old ReplicaSets while preserving the current active ones
5. **Reporting**: It provides a detailed summary of the cleanup operation

## Safety

The script is designed with safety in mind:

- Only deletes ReplicaSets with 0 desired and 0 current replicas
- Never touches active ReplicaSets
- Provides dry-run mode for testing
- Shows detailed information about what will be deleted
- Includes error handling for failed deletions

## Scheduling

You can schedule this script to run periodically using cron:

```bash
# Add to crontab to run daily at 2 AM
0 2 * * * /path/to/k8s-cleanup-replicasets.sh --namespace webapps >/dev/null 2>&1

# Run weekly on Sundays at 3 AM with logging
0 3 * * 0 /path/to/k8s-cleanup-replicasets.sh --namespace webapps >> /var/log/k8s-cleanup.log 2>&1
```

## Kubernetes Integration

You can also run this as a Kubernetes CronJob:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: replicaset-cleanup
  namespace: webapps
spec:
  schedule: "0 2 * * *"  # Daily at 2 AM
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: cleanup
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              # Your cleanup script here
              kubectl get replicasets -n webapps --no-headers | awk '$2 == 0 && $3 == 0 && $4 == 0 {print $1}' | xargs -r kubectl delete replicaset -n webapps
          restartPolicy: OnFailure
          serviceAccountName: cleanup-sa
```

## Prerequisites

- `kubectl` installed and configured
- Appropriate Kubernetes permissions to list and delete ReplicaSets
- Access to the target namespace

## Troubleshooting

1. **Permission denied**: Make sure you have the necessary RBAC permissions
2. **Namespace not found**: Verify the namespace exists and is accessible
3. **kubectl not found**: Install kubectl or add it to your PATH
4. **ReplicaSet deletion failed**: Check if the ReplicaSet is owned by a deployment that's being updated

## Contributing

Feel free to submit issues or pull requests to improve the cleanup script.
