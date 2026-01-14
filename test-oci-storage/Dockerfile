# Dockerfile for OCI Storage Service Test
# This builds a container that can be deployed as a pod to test OCI storage integration
# Build from the root of the workspace: docker build -f test-oci-storage/Dockerfile .

FROM node:24-alpine AS base

# Install pnpm and required tools
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    && corepack enable && corepack prepare pnpm@latest --activate

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy shared package files
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/

# Install dependencies (only what's needed for the test)
RUN pnpm install --frozen-lockfile --filter @langfuse/shared

# Copy test files
COPY test-oci-storage/ ./test-oci-storage/

# Set working directory to test folder
WORKDIR /app/test-oci-storage

# Environment variables (can be overridden at runtime)
ENV OCI_REGION=us-phoenix-1
ENV NODE_ENV=production

# Install ts-node globally for easier execution
RUN npm install -g ts-node typescript

# Run the test
# Note: We use the node_modules from the shared package
CMD ["ts-node", "--project", "../packages/shared/tsconfig.json", "--transpile-only", "test-oci.ts"]

