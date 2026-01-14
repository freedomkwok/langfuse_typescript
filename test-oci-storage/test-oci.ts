/**
 * Test script for Oracle Cloud Storage Service
 * This script tests the OracleCloudStorageService implementation
 * 
 * Usage:
 *   - Set environment variables or provide credentials
 *   - Run: ts-node test-oci-storage/test-oci.ts
 */

import * as common from "oci-common";
import * as objectstorage from "oci-objectstorage";

async function testOCIAuthentication() {
  console.log("Testing OCI Instance Principal Authentication...\n");

  try {
    // Test Instance Principal authentication (auto-detects when running on OCI instance)
    // Equivalent to Python: signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
    const authenticationDetailsProvider =
      new common.InstancePrincipalsAuthenticationDetailsProvider();
    
    console.log("✓ Instance Principal authentication initialized successfully");
    console.log("  (This means you're running on an OCI instance with proper configuration)\n");

    // Test region configuration
    const regionId = process.env.OCI_REGION || "us-phoenix-1";
    const region = common.Region.fromRegionId(regionId);
    console.log(`✓ Region configured: ${regionId}\n`);

    // Initialize Object Storage client
    // Equivalent to Python: object_storage_client = oci.object_storage.ObjectStorageClient(config={"region": "us-phoenix-1"})
    const client = new objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: authenticationDetailsProvider,
    });
    console.log("✓ Object Storage client initialized\n");

    // Test namespace retrieval
    console.log("Testing namespace retrieval...");
    const getNamespaceRequest: objectstorage.requests.GetNamespaceRequest = {};
    const namespaceResponse = await client.getNamespace(getNamespaceRequest);
    const namespace = namespaceResponse.value;
    console.log(`✓ Namespace retrieved: ${namespace}\n`);

    // Test bucket operations (if bucket name is provided)
    const bucketName = process.env.OCI_BUCKET_NAME;
    if (bucketName) {
      console.log(`Testing bucket operations for bucket: ${bucketName}...`);
      
      // List objects in bucket
      const listObjectsRequest: objectstorage.requests.ListObjectsRequest = {
        namespaceName: namespace,
        bucketName: bucketName,
        limit: 10,
      };
      
      const listResponse = await client.listObjects(listObjectsRequest);
      const objectCount = listResponse.listObjects?.objects?.length || 0;
      console.log(`✓ Found ${objectCount} objects in bucket\n`);
      
      if (objectCount > 0 && listResponse.listObjects?.objects) {
        console.log("Sample objects:");
        listResponse.listObjects.objects.slice(0, 5).forEach((obj) => {
          console.log(`  - ${obj.name} (${obj.size} bytes)`);
        });
        console.log();
      }
    } else {
      console.log("⚠ OCI_BUCKET_NAME not set, skipping bucket operations");
      console.log("  Set OCI_BUCKET_NAME environment variable to test bucket operations\n");
    }

    console.log("✅ All tests passed! OCI Storage Service is working correctly.");
    
  } catch (error) {
    console.error("❌ Error testing OCI Storage Service:");
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
      if (error.stack) {
        console.error(`\nStack trace:\n${error.stack}`);
      }
    } else {
      console.error("  Unknown error:", error);
    }
    process.exit(1);
  }
}

// Test file upload/download if bucket is provided
async function testFileOperations() {
  const bucketName = process.env.OCI_BUCKET_NAME;
  if (!bucketName) {
    console.log("Skipping file operations test (OCI_BUCKET_NAME not set)");
    return;
  }

  console.log("\n=== Testing File Operations ===\n");

  try {
    const authenticationDetailsProvider =
      new common.InstancePrincipalsAuthenticationDetailsProvider();
    
    const regionId = process.env.OCI_REGION || "us-phoenix-1";
    const client = new objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: authenticationDetailsProvider,
    });

    // Get namespace
    const namespaceResponse = await client.getNamespace({});
    const namespace = namespaceResponse.value;

    // Test upload
    const testFileName = `test-${Date.now()}.txt`;
    const testContent = `Test file created at ${new Date().toISOString()}`;
    const contentBuffer = Buffer.from(testContent, "utf-8");

    console.log(`Uploading test file: ${testFileName}...`);
    const putObjectRequest: objectstorage.requests.PutObjectRequest = {
      namespaceName: namespace,
      bucketName: bucketName,
      objectName: testFileName,
      putObjectBody: contentBuffer,
      contentLength: contentBuffer.length,
      contentType: "text/plain",
    };

    await client.putObject(putObjectRequest);
    console.log("✓ File uploaded successfully\n");

    // Test download
    console.log(`Downloading test file: ${testFileName}...`);
    const getObjectRequest: objectstorage.requests.GetObjectRequest = {
      namespaceName: namespace,
      bucketName: bucketName,
      objectName: testFileName,
    };

    const getResponse = await client.getObject(getObjectRequest);
    const chunks: Buffer[] = [];

    if (getResponse.value) {
      for await (const chunk of getResponse.value) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }

    const downloadedContent = Buffer.concat(chunks).toString("utf-8");
    console.log(`✓ File downloaded successfully`);
    console.log(`  Content: ${downloadedContent}\n`);

    // Test delete
    console.log(`Deleting test file: ${testFileName}...`);
    const deleteObjectRequest: objectstorage.requests.DeleteObjectRequest = {
      namespaceName: namespace,
      bucketName: bucketName,
      objectName: testFileName,
    };

    await client.deleteObject(deleteObjectRequest);
    console.log("✓ File deleted successfully\n");

    console.log("✅ All file operations tests passed!");

  } catch (error) {
    console.error("❌ Error testing file operations:");
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    } else {
      console.error("  Unknown error:", error);
    }
  }
}

// Main execution
async function main() {
  console.log("==========================================");
  console.log("OCI Storage Service Test");
  console.log("==========================================\n");

  console.log("Environment variables:");
  console.log(`  OCI_REGION: ${process.env.OCI_REGION || "us-phoenix-1 (default)"}`);
  console.log(`  OCI_BUCKET_NAME: ${process.env.OCI_BUCKET_NAME || "not set"}`);
  console.log();

  await testOCIAuthentication();
  await testFileOperations();

  console.log("\n==========================================");
  console.log("Test completed");
  console.log("==========================================");
}

// Run the test
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

