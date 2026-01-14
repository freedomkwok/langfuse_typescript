#!/bin/bash
# Script to build and push OCI Storage Test image to OCI Container Registry

set -e

# Configuration - Update these values
REGION="${OCI_REGION:-us-phoenix-1}"
TENANCY_NAMESPACE="${OCI_TENANCY_NAMESPACE:-}"
IMAGE_NAME="oci-storage-test"
IMAGE_TAG="${IMAGE_TAG:-latest}"

if [ -z "$TENANCY_NAMESPACE" ]; then
  echo "Error: OCI_TENANCY_NAMESPACE environment variable is not set"
  echo "You can find your tenancy namespace in OCI Console under Tenancy Details"
  exit 1
fi

# Full image URL
FULL_IMAGE_NAME="${REGION}.ocir.io/${TENANCY_NAMESPACE}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "Building Docker image..."
docker build -f test-oci-storage/Dockerfile -t ${IMAGE_NAME}:${IMAGE_TAG} .

echo "Tagging image for OCI Container Registry..."
docker tag ${IMAGE_NAME}:${IMAGE_TAG} ${FULL_IMAGE_NAME}

echo "Logging in to OCI Container Registry..."
echo "Please enter your OCI username (usually: <tenancy-namespace>/<username>)"
docker login ${REGION}.ocir.io

echo "Pushing image to OCI Container Registry..."
docker push ${FULL_IMAGE_NAME}

echo ""
echo "✅ Image pushed successfully!"
echo "Image URL: ${FULL_IMAGE_NAME}"
echo ""
echo "You can now use this image to create a Container Instance:"
echo "  oci container-instances container-instance create \\"
echo "    --compartment-id <compartment-ocid> \\"
echo "    --display-name oci-storage-test \\"
echo "    --containers '[{"
echo "      \"imageUrl\": \"${FULL_IMAGE_NAME}\","
echo "      \"displayName\": \"test-container\","
echo "      \"environmentVariables\": {"
echo "        \"OCI_BUCKET_NAME\": \"your-bucket-name\","
echo "        \"OCI_REGION\": \"${REGION}\""
echo "      }"
echo "    }]' \\"
echo "    --shape \"CI.Standard.E3.Flex\" \\"
echo "    --shape-config '{\"ocpus\": 1, \"memoryInGBs\": 1}'"

