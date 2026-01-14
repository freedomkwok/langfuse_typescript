# OCI Storage Service Test

This folder contains a test script to verify that Oracle Cloud Infrastructure (OCI) Object Storage integration is working correctly.

## Prerequisites

1. **Running on an OCI Instance**: This test requires Instance Principal authentication, which only works when running on an OCI compute instance (VM, Container Instance, etc.) with proper IAM policies configured.

2. **IAM Policies**: The instance must have the following IAM policies:
   ```
   Allow dynamic-group <your-dynamic-group> to manage objects in compartment <your-compartment>
   Allow dynamic-group <your-dynamic-group> to read buckets in compartment <your-compartment>
   ```

3. **Node.js and TypeScript**: Ensure you have Node.js and TypeScript installed.

## Installation

Install the required OCI SDK packages:

```bash
cd packages/shared
pnpm install
```

Or from the root:

```bash
pnpm install
```

## Usage

### Basic Test (Authentication and Namespace)

```bash
# From the root of the workspace
ts-node test-oci-storage/test-oci.ts
```

### Full Test (Including File Operations)

Set the bucket name environment variable:

```bash
export OCI_BUCKET_NAME=your-bucket-name
export OCI_REGION=us-phoenix-1  # Optional, defaults to us-phoenix-1
ts-node test-oci-storage/test-oci.ts
```

## Docker/Pod Deployment

### Build the Docker Image

```bash
# From the root of the workspace
docker build -f test-oci-storage/Dockerfile -t oci-storage-test:latest .
```

### Run as Container

```bash
docker run --rm \
  -e OCI_BUCKET_NAME=your-bucket-name \
  -e OCI_REGION=us-phoenix-1 \
  oci-storage-test:latest
```

### Deploy as OCI Container Instance

1. **Push to OCI Container Registry**:
   ```bash
   # Login to OCI
   docker login <region>.ocir.io
   
   # Tag the image
   docker tag oci-storage-test:latest <region>.ocir.io/<tenancy-namespace>/oci-storage-test:latest
   
   # Push
   docker push <region>.ocir.io/<tenancy-namespace>/oci-storage-test:latest
   ```

2. **Create Container Instance**:
   - Use OCI Console or CLI to create a Container Instance
   - Use the pushed image
   - Set environment variables:
     - `OCI_BUCKET_NAME`: Your bucket name
     - `OCI_REGION`: Your region (e.g., `us-phoenix-1`)
   - Ensure the Container Instance is in a Dynamic Group with proper IAM policies

3. **Using OCI CLI**:
   ```bash
   oci container-instances container-instance create \
     --compartment-id <compartment-ocid> \
     --display-name oci-storage-test \
     --containers '[{
       "imageUrl": "<region>.ocir.io/<tenancy-namespace>/oci-storage-test:latest",
       "displayName": "test-container",
       "environmentVariables": {
         "OCI_BUCKET_NAME": "your-bucket-name",
         "OCI_REGION": "us-phoenix-1"
       }
     }]' \
     --shape "CI.Standard.E3.Flex" \
     --shape-config '{"ocpus": 1, "memoryInGBs": 1}'
   ```

### Deploy as Kubernetes Pod

Create a `k8s-pod.yaml`:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: oci-storage-test
spec:
  containers:
  - name: test
    image: oci-storage-test:latest
    env:
    - name: OCI_BUCKET_NAME
      value: "your-bucket-name"
    - name: OCI_REGION
      value: "us-phoenix-1"
  restartPolicy: Never
```

Deploy:
```bash
kubectl apply -f test-oci-storage/k8s-pod.yaml
kubectl logs -f oci-storage-test
```

### Using Docker Compose

```bash
cd test-oci-storage
OCI_BUCKET_NAME=your-bucket-name OCI_REGION=us-phoenix-1 docker-compose up
```

## What the Test Does

1. **Authentication Test**: Verifies that Instance Principal authentication works
2. **Namespace Retrieval**: Tests getting the OCI namespace
3. **Bucket Listing**: Lists objects in the specified bucket (if `OCI_BUCKET_NAME` is set)
4. **File Operations** (if bucket is provided):
   - Upload a test file
   - Download the test file
   - Delete the test file

## Expected Output

When running on an OCI instance with proper configuration:

```
==========================================
OCI Storage Service Test
==========================================

Environment variables:
  OCI_REGION: us-phoenix-1 (default)
  OCI_BUCKET_NAME: your-bucket-name

Testing OCI Instance Principal Authentication...

✓ Instance Principal authentication initialized successfully
  (This means you're running on an OCI instance with proper configuration)

✓ Region configured: us-phoenix-1

✓ Object Storage client initialized

Testing namespace retrieval...
✓ Namespace retrieved: your-namespace

Testing bucket operations for bucket: your-bucket-name...
✓ Found X objects in bucket

✅ All tests passed! OCI Storage Service is working correctly.
```

## Troubleshooting

### Error: Instance Principal authentication failed

- **Cause**: Not running on an OCI instance, or instance doesn't have proper IAM policies
- **Solution**: Ensure you're running on an OCI compute instance with the required IAM policies

### Error: Cannot find module 'oci-common' or 'oci-objectstorage'

- **Cause**: OCI SDK packages not installed
- **Solution**: Run `pnpm install` in the `packages/shared` directory

### Error: Namespace retrieval failed

- **Cause**: Insufficient permissions or network issues
- **Solution**: Check IAM policies and network connectivity

### Docker Build Fails

- **Cause**: Missing dependencies or incorrect paths
- **Solution**: Ensure you're building from the root of the workspace, and all package files are present

## Notes

- This test uses **Instance Principal authentication only** - it will not work with API keys or config files
- The test automatically detects the region or uses `us-phoenix-1` as default
- All file operations use a test file that is automatically cleaned up
- When deployed as a Container Instance or Pod on OCI, Instance Principal authentication is automatically available
