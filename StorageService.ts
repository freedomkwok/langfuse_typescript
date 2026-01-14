import { Readable } from "stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { Storage, Bucket, GetSignedUrlConfig } from "@google-cloud/storage";
import * as common from "oci-common";
import * as objectstorage from "oci-objectstorage";
import { logger } from "../logger";
import { env } from "../../env";
import { backOff } from "exponential-backoff";
import { ServiceUnavailableError } from "../../errors";

type UploadFile = {
  fileName: string;
  fileType: string;
  data: Readable | string;
  partSize?: number; // Optional: Part size in bytes for multipart uploads (S3 only)
  queueSize?: number; // Optional: Number of concurrent part uploads (S3 only)
};

type UploadWithSignedUrl = UploadFile & {
  expiresInSeconds: number;
};

/**
 * Check if an error is a DNS lookup failure (EAI_AGAIN)
 * and throw ServiceUnavailableError if so, otherwise rethrow the original error
 */
function handleStorageError(err: unknown, operation: string): never {
  // Check if error has a code property matching EAI_AGAIN
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    err.code === "EAI_AGAIN"
  ) {
    logger.error(`DNS lookup failure during ${operation}`, err);
    throw new ServiceUnavailableError(
      "Storage service temporarily unavailable due to network issues",
    );
  }
  // For other errors, throw a generic error
  throw Error(`Failed to ${operation}`);
}

export interface StorageService {
  uploadFile(params: UploadFile): Promise<void>;

  uploadWithSignedUrl(
    params: UploadWithSignedUrl,
  ): Promise<{ signedUrl: string }>;

  uploadJson(path: string, body: Record<string, unknown>[]): Promise<void>;

  download(path: string): Promise<string>;

  listFiles(prefix: string): Promise<{ file: string; createdAt: Date }[]>;

  getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment?: boolean,
  ): Promise<string>;

  getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string>;

  deleteFiles(paths: string[]): Promise<void>;
}

export class StorageServiceFactory {
  /**
   * Get an instance of the StorageService
   * @param params.accessKeyId - Access key ID
   * @param params.secretAccessKey - Secret access key
   * @param params.bucketName - Bucket name to store files
   * @param params.endpoint - Endpoint - Endpoint to an S3 compatible API (or Azure Blob Storage)
   * @param params.externalEndpoint - External endpoint to replace the internal endpoint in the signed URL.
   * @param params.region - Region in which the bucket resides
   * @param params.forcePathStyle - Add bucket name into the path instead of the domain name. Mainly used for MinIO.
   * @param params.useAzureBlob - Use Azure Blob Storage instead of S3
   * @param params.useGoogleCloudStorage - Use Google Cloud Storage instead of S3
   * @param params.googleCloudCredentials - Google Cloud Storage credentials JSON string or path to credentials file
   * @param params.useOracleCloudStorage - Use Oracle Cloud Storage instead of S3
   * @param params.oracleCloudCredentials - Oracle Cloud Storage credentials JSON string or path to credentials file
   * @param params.awsSse - Server-side encryption method (e.g., "aws:kms")
   * @param params.awsSseKmsKeyId - SSE KMS Key ID when using KMS encryption
   */
  public static getInstance(params: {
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    bucketName: string;
    endpoint: string | undefined;
    externalEndpoint?: string | undefined;
    region: string | undefined;
    forcePathStyle: boolean;
    useAzureBlob?: boolean;
    useGoogleCloudStorage?: boolean;
    googleCloudCredentials?: string;
    useOracleCloudStorage?: boolean;
    oracleCloudCredentials?: string;
    awsSse: string | undefined;
    awsSseKmsKeyId: string | undefined;
  }): StorageService {
    if (
      params.useAzureBlob !== undefined
        ? params.useAzureBlob
        : env.LANGFUSE_USE_AZURE_BLOB === "true"
    ) {
      return new AzureBlobStorageService(params);
    }
    if (
      params.useGoogleCloudStorage !== undefined
        ? params.useGoogleCloudStorage
        : env.LANGFUSE_USE_GOOGLE_CLOUD_STORAGE === "true"
    ) {
      // Use provided credentials or fall back to environment variable
      const googleParams = {
        ...params,
        googleCloudCredentials:
          params.googleCloudCredentials ||
          env.LANGFUSE_GOOGLE_CLOUD_STORAGE_CREDENTIALS,
      };
      return new GoogleCloudStorageService(googleParams);
    }
    if (
      params.useOracleCloudStorage !== undefined
        ? params.useOracleCloudStorage
        : env.LANGFUSE_USE_ORACLE_CLOUD_STORAGE === "true"
    ) {
      // Use provided credentials or fall back to environment variable
      const oracleParams = {
        ...params,
        oracleCloudCredentials:
          params.oracleCloudCredentials ||
          env.LANGFUSE_ORACLE_CLOUD_STORAGE_CREDENTIALS,
      };
      return new OracleCloudStorageService(oracleParams);
    }
    return new S3StorageService(params);
  }
}

let azureContainersExists: Record<string, boolean> = {};
class AzureBlobStorageService implements StorageService {
  private client: ContainerClient;
  private container: string;
  private externalEndpoint: string | undefined;

  constructor(params: {
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    bucketName: string;
    endpoint: string | undefined;
    externalEndpoint?: string | undefined;
    region: string | undefined;
    forcePathStyle: boolean;
  }) {
    const { accessKeyId, secretAccessKey, endpoint, externalEndpoint } = params;
    if (!accessKeyId || !secretAccessKey || !endpoint) {
      throw new Error(
        `Endpoint, account and account key must be configured to use Azure Blob Storage`,
      );
    }

    this.externalEndpoint = externalEndpoint;
    const sharedKeyCredential = new StorageSharedKeyCredential(
      accessKeyId,
      secretAccessKey,
    );
    const blobServiceClient = new BlobServiceClient(
      endpoint,
      sharedKeyCredential,
    );
    this.container = params.bucketName;
    this.client = blobServiceClient.getContainerClient(this.container);
  }

  private async createContainerIfNotExists(): Promise<void> {
    // Skip container existence check if environment variable is set
    if (env.LANGFUSE_AZURE_SKIP_CONTAINER_CHECK === "true") {
      return;
    }

    try {
      if (azureContainersExists[this.container]) {
        return; // Container already exists, no need to create it again
      }
      await this.client.createIfNotExists();
      azureContainersExists[this.container] = true; // Mark container as created
      logger.info(`Azure Blob Storage container ${this.container} created`);
    } catch (err) {
      logger.error(
        `Failed to create Azure Blob Storage container ${this.container}`,
        err,
      );
      handleStorageError(err, "create Azure Blob Storage container");
    }
  }

  public async uploadFile(params: UploadFile): Promise<void> {
    const { fileName, fileType, data, partSize } = params;
    try {
      await this.createContainerIfNotExists();

      const blockBlobClient = this.client.getBlockBlobClient(fileName);

      if (typeof data === "string") {
        await blockBlobClient.upload(data, data.length, {
          blobHTTPHeaders: { blobContentType: fileType },
        });
      } else if (data instanceof Readable) {
        // bufferSize controls the block size (default 8MB supports ~800GB files)
        const bufferSize = partSize ?? 8 * 1024 * 1024; // Default 8MB per block
        const maxConcurrency = 5; // Default value

        await blockBlobClient.uploadStream(data, bufferSize, maxConcurrency, {
          blobHTTPHeaders: { blobContentType: fileType },
        });
      } else {
        throw new Error("Unsupported data type. Must be Readable or string.");
      }

      return;
    } catch (err) {
      logger.error(
        `Failed to upload file to Azure Blob Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Azure Blob Storage");
    }
  }

  public async uploadWithSignedUrl(
    params: UploadWithSignedUrl,
  ): Promise<{ signedUrl: string }> {
    const { fileName, data, fileType, expiresInSeconds } = params;
    try {
      await this.uploadFile({ fileName, data, fileType });

      return {
        signedUrl: await this.getSignedUrl(fileName, expiresInSeconds, false),
      };
    } catch (err) {
      logger.error(
        `Failed to upload file to Azure Blob Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Azure Blob Storage");
    }
  }

  public async uploadJson(
    path: string,
    body: Record<string, unknown>[],
  ): Promise<void> {
    await this.createContainerIfNotExists();

    const blockBlobClient = this.client.getBlockBlobClient(path);
    const content = JSON.stringify(body);
    try {
      await blockBlobClient.upload(content, content.length);
    } catch (err) {
      logger.error(`Failed to upload JSON to Azure Blob Storage ${path}`, err);
      handleStorageError(err, "upload JSON to Azure Blob Storage");
    }
  }

  private async streamToString(
    readableStream: NodeJS.ReadableStream,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      readableStream.on("data", (data) => {
        chunks.push(data.toString());
      });
      readableStream.on("end", () => {
        resolve(chunks.join(""));
      });
      readableStream.on("error", reject);
    });
  }

  public async download(path: string): Promise<string> {
    try {
      await this.createContainerIfNotExists();

      const blobClient = this.client.getBlobClient(path);
      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody) {
        throw Error("No stream body available");
      }
      return this.streamToString(downloadResponse.readableStreamBody);
    } catch (err) {
      logger.error(
        `Failed to download file from Azure Blob Storage ${path}`,
        err,
      );
      handleStorageError(err, "download file from Azure Blob Storage");
    }
  }

  public async deleteFiles(paths: string[]): Promise<void> {
    await backOff(() => this.deleteFileNonRetrying(paths), {
      numOfAttempts: 3,
    });
  }

  async deleteFileNonRetrying(paths: string[]): Promise<void> {
    try {
      await this.createContainerIfNotExists();

      await Promise.all(
        paths.map(async (path) => {
          const blobClient = this.client.getBlobClient(path);
          await blobClient.deleteIfExists();
        }),
      );
    } catch (err) {
      logger.error(
        `Failed to delete files from Azure Blob Storage ${paths}`,
        err,
      );
      handleStorageError(err, "delete files from Azure Blob Storage");
    }
  }

  public async listFiles(
    prefix: string,
  ): Promise<{ file: string; createdAt: Date }[]> {
    try {
      await this.createContainerIfNotExists();

      const result = await this.client.listBlobsFlat({ prefix });
      const files = [];
      for await (const blob of result) {
        if (blob.name.startsWith(prefix)) {
          files.push({
            file: blob.name,
            createdAt: blob?.properties?.createdOn ?? new Date(),
          });
        }
      }
      return files;
    } catch (err) {
      logger.error(
        `Failed to list files from Azure Blob Storage ${prefix}`,
        err,
      );
      handleStorageError(err, "list files from Azure Blob Storage");
    }
  }

  public async getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment?: boolean,
  ): Promise<string> {
    try {
      await this.createContainerIfNotExists();

      const blockBlobClient = this.client.getBlockBlobClient(fileName);
      let url = await blockBlobClient.generateSasUrl({
        permissions: BlobSASPermissions.parse("r"),
        expiresOn: new Date(Date.now() + ttlSeconds * 1000),
        contentDisposition: asAttachment
          ? `attachment; filename="${fileName}"`
          : undefined,
      });

      // Replace internal endpoint with external endpoint if configured
      if (this.externalEndpoint && url.includes(this.client.url)) {
        url = url.replace(this.client.url, this.externalEndpoint);
      }

      return url;
    } catch (err) {
      logger.error(
        `Failed to generate presigned URL for Azure Blob Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "generate presigned URL for Azure Blob Storage");
    }
  }

  public async getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    const { path, ttlSeconds, contentType } = params;
    try {
      await this.createContainerIfNotExists();

      const blockBlobClient = this.client.getBlockBlobClient(path);
      let url = await blockBlobClient.generateSasUrl({
        permissions: BlobSASPermissions.parse("w"),
        expiresOn: new Date(Date.now() + ttlSeconds * 1000),
        contentType: contentType,
      });

      // Replace internal endpoint with external endpoint if configured
      if (this.externalEndpoint && url.includes(this.client.url)) {
        url = url.replace(this.client.url, this.externalEndpoint);
      }

      return url;
    } catch (err) {
      logger.error(
        `Failed to generate presigned upload URL for Azure Blob Storage ${path}`,
        err,
      );
      handleStorageError(
        err,
        "generate presigned upload URL for Azure Blob Storage",
      );
    }
  }
}

class S3StorageService implements StorageService {
  private client: S3Client;
  private signedUrlClient: S3Client;
  private bucketName: string;
  private awsSse: string | undefined;
  private awsSseKmsKeyId: string | undefined;

  constructor(params: {
    accessKeyId: string | undefined;
    secretAccessKey: string | undefined;
    bucketName: string;
    endpoint: string | undefined;
    externalEndpoint?: string | undefined;
    region: string | undefined;
    forcePathStyle: boolean;
    awsSse: string | undefined;
    awsSseKmsKeyId: string | undefined;
  }) {
    // Use accessKeyId and secretAccessKey if provided or fallback to default credentials
    const { accessKeyId, secretAccessKey } = params;
    const credentials =
      accessKeyId !== undefined && secretAccessKey !== undefined
        ? {
            accessKeyId,
            secretAccessKey,
          }
        : undefined;

    // Create the main client for S3 operations using the internal endpoint
    this.client = new S3Client({
      credentials,
      endpoint: params.endpoint,
      region: params.region,
      forcePathStyle: params.forcePathStyle,
      requestHandler: {
        httpsAgent: {
          maxSockets: env.LANGFUSE_S3_CONCURRENT_WRITES,
        },
      },
    });

    // Create a separate client for generating presigned URLs
    // If an external endpoint is provided, use it for the URL client
    // Otherwise, use the same client for both operations
    this.signedUrlClient = params.externalEndpoint
      ? new S3Client({
          credentials,
          endpoint: params.externalEndpoint,
          region: params.region,
          forcePathStyle: params.forcePathStyle,
          requestHandler: {
            httpsAgent: {
              maxSockets: env.LANGFUSE_S3_CONCURRENT_WRITES,
            },
          },
        })
      : this.client;

    this.bucketName = params.bucketName;
    this.awsSse = params.awsSse;
    this.awsSseKmsKeyId = params.awsSseKmsKeyId;
  }

  private addSSEToParams<T>(params: Record<string, unknown>): T {
    if (this.awsSse) {
      params.ServerSideEncryption = this.awsSse;
      if (this.awsSse === "aws:kms" && this.awsSseKmsKeyId) {
        params.SSEKMSKeyId = this.awsSseKmsKeyId;
      }
    }
    return params as T;
  }

  public async uploadFile({
    fileName,
    fileType,
    data,
    partSize,
    queueSize,
  }: UploadFile): Promise<void> {
    try {
      await new Upload({
        client: this.client,
        params: this.addSSEToParams<PutObjectCommandInput>({
          Bucket: this.bucketName,
          Key: fileName,
          Body: data,
          ContentType: fileType,
        }),
        // Use provided partSize and queueSize, or fall back to defaults
        // Default: 5 MB part size supports files up to ~50 GB (5 MB × 10,000 parts)
        // For large files, use partSize: 100 * 1024 * 1024 (100 MB) to support up to ~1 TB
        partSize: partSize,
        queueSize: queueSize,
      }).done();

      return;
    } catch (err) {
      logger.error(`Failed to upload file to ${fileName}`, err);
      handleStorageError(err, "upload file to S3");
    }
  }

  public async uploadWithSignedUrl({
    fileName,
    fileType,
    data,
    expiresInSeconds,
    partSize,
    queueSize,
  }: UploadWithSignedUrl): Promise<{ signedUrl: string }> {
    try {
      await this.uploadFile({ fileName, data, fileType, partSize, queueSize });

      const signedUrl = await this.getSignedUrl(fileName, expiresInSeconds);

      return { signedUrl };
    } catch (err) {
      logger.error(`Failed to upload file to ${fileName}`, err);
      handleStorageError(err, "upload file to S3 or generate signed URL");
    }
  }

  public async uploadJson(path: string, body: Record<string, unknown>[]) {
    const putCommand = new PutObjectCommand(
      this.addSSEToParams({
        Bucket: this.bucketName,
        Key: path,
        Body: JSON.stringify(body),
        ContentType: "application/json",
      }),
    );

    try {
      await this.client.send(putCommand);
    } catch (err) {
      logger.error(`Failed to upload JSON to S3 ${path}`, err);
      handleStorageError(err, "upload JSON to S3");
    }
  }

  public async download(path: string): Promise<string> {
    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: path,
    });

    try {
      const response = await this.client.send(getCommand);
      return (await response.Body?.transformToString()) ?? "";
    } catch (err) {
      logger.error(`Failed to download file from S3 ${path}`, err);
      handleStorageError(err, "download file from S3");
    }
  }

  public async listFiles(
    prefix: string,
  ): Promise<{ file: string; createdAt: Date }[]> {
    const listCommand = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
      MaxKeys: env.LANGFUSE_S3_LIST_MAX_KEYS,
    });

    try {
      const response = await this.client.send(listCommand);
      return (
        response.Contents?.flatMap((file) =>
          file.Key
            ? [{ file: file.Key, createdAt: file.LastModified ?? new Date() }]
            : [],
        ) ?? []
      );
    } catch (err) {
      logger.error(`Failed to list files from S3 ${prefix}`, err);
      handleStorageError(err, "list files from S3");
    }
  }

  public async getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment: boolean = true,
  ): Promise<string> {
    try {
      return getSignedUrl(
        this.signedUrlClient,
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: fileName,
          ResponseContentDisposition: asAttachment
            ? `attachment; filename="${fileName}"`
            : undefined,
        }),
        { expiresIn: ttlSeconds },
      );
    } catch (err) {
      logger.error(`Failed to generate presigned URL for ${fileName}`, err);
      handleStorageError(err, "generate signed URL");
    }
  }

  public async deleteFiles(paths: string[]): Promise<void> {
    await backOff(() => this.deleteFilesNonRetrying(paths), {
      numOfAttempts: 3,
    });
  }

  async deleteFilesNonRetrying(paths: string[]): Promise<void> {
    const chunkSize = 900;
    const chunks = [];

    for (let i = 0; i < paths.length; i += chunkSize) {
      chunks.push(paths.slice(i, i + chunkSize));
    }

    try {
      for (const chunk of chunks) {
        const command = new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: chunk.map((path) => ({ Key: path })),
            Quiet: true,
          },
        });
        const result = await this.client.send(command);
        if (result?.Errors && result?.Errors?.length > 0) {
          const errors = result.Errors.map((e) => e.Key).join(", ");
          logger.error(`Failed to delete files from S3: ${errors} `, {
            errors: result.Errors,
            files: chunk,
          });
          throw new Error(`Failed to delete files from S3: ${errors}`);
        }
      }
    } catch (err) {
      logger.error(`Failed to delete files from S3`, {
        error: err,
        files: paths,
      });
      handleStorageError(err, "delete files from S3");
    }
  }

  public async getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    const { path, ttlSeconds, contentType, contentLength, sha256Hash } = params;

    return getSignedUrl(
      this.signedUrlClient,
      new PutObjectCommand(
        this.addSSEToParams({
          Bucket: this.bucketName,
          Key: path,
          ContentType: contentType,
          ChecksumSHA256: sha256Hash,
          ContentLength: contentLength,
        }),
      ),
      {
        expiresIn: ttlSeconds,
        signableHeaders: new Set(["content-type", "content-length"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );
  }
}

class GoogleCloudStorageService implements StorageService {
  private storage: Storage;
  private bucket: Bucket;

  constructor(params: { bucketName: string; googleCloudCredentials?: string }) {
    // Initialize Google Cloud Storage client
    if (params.googleCloudCredentials) {
      try {
        // Check if the credentials are a JSON string or a path to a file
        if (params.googleCloudCredentials.trim().startsWith("{")) {
          // It's a JSON string
          this.storage = new Storage({
            credentials: JSON.parse(params.googleCloudCredentials),
          });
        } else {
          // It's a path to a credentials file
          this.storage = new Storage({
            keyFilename: params.googleCloudCredentials,
          });
        }
      } catch (err) {
        logger.error("Failed to parse Google Cloud Storage credentials", err);
        throw new Error("Failed to initialize Google Cloud Storage");
      }
    } else {
      // Use default authentication (environment variables or instance metadata)
      this.storage = new Storage();
    }

    this.bucket = this.storage.bucket(params.bucketName);
  }

  public async uploadFile({
    fileName,
    fileType,
    data,
  }: UploadFile): Promise<void> {
    try {
      const file = this.bucket.file(fileName);
      const options = {
        contentType: fileType,
        resumable: false,
      };

      if (typeof data === "string") {
        await file.save(data, options);
        return;
      } else if (data instanceof Readable) {
        return new Promise((resolve, reject) => {
          const writeStream = file.createWriteStream(options);

          data
            .pipe(writeStream)
            .on("error", (err: unknown) => {
              reject(err);
            })
            .on("finish", () => {
              resolve();
            });
        });
      } else {
        throw new Error("Unsupported data type. Must be Readable or string.");
      }
    } catch (err) {
      logger.error(
        `Failed to upload file to Google Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Google Cloud Storage");
    }
  }

  public async uploadWithSignedUrl({
    fileName,
    fileType,
    data,
    expiresInSeconds,
  }: UploadWithSignedUrl): Promise<{ signedUrl: string }> {
    try {
      await this.uploadFile({ fileName, data, fileType });
      const signedUrl = await this.getSignedUrl(fileName, expiresInSeconds);
      return { signedUrl };
    } catch (err) {
      logger.error(
        `Failed to upload file to Google Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Google Cloud Storage");
    }
  }

  public async uploadJson(
    path: string,
    body: Record<string, unknown>[],
  ): Promise<void> {
    try {
      const file = this.bucket.file(path);
      const content = JSON.stringify(body);

      await file.save(content, {
        contentType: "application/json",
        resumable: false,
      });
    } catch (err) {
      logger.error(
        `Failed to upload JSON to Google Cloud Storage ${path}`,
        err,
      );
      handleStorageError(err, "upload JSON to Google Cloud Storage");
    }
  }

  public async download(path: string): Promise<string> {
    try {
      const file = this.bucket.file(path);
      const [content] = await file.download();

      return content.toString();
    } catch (err) {
      logger.error(
        `Failed to download file from Google Cloud Storage ${path}`,
        err,
      );
      handleStorageError(err, "download file from Google Cloud Storage");
    }
  }

  public async listFiles(
    prefix: string,
  ): Promise<{ file: string; createdAt: Date }[]> {
    try {
      const [files] = await this.bucket.getFiles({ prefix });

      return files.map((file) => ({
        file: file.name,
        createdAt: new Date(file.metadata.timeCreated ?? new Date()),
      }));
    } catch (err) {
      logger.error(
        `Failed to list files from Google Cloud Storage ${prefix}`,
        err,
      );
      handleStorageError(err, "list files from Google Cloud Storage");
    }
  }

  public async getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment: boolean = false,
  ): Promise<string> {
    try {
      const file = this.bucket.file(fileName);

      const options: GetSignedUrlConfig = {
        version: "v4",
        action: "read",
        expires: Date.now() + ttlSeconds * 1000,
      };

      if (asAttachment) {
        options.responseDisposition = `attachment; filename="${fileName}"`;
      }

      const [url] = await file.getSignedUrl(options);
      return url;
    } catch (err) {
      logger.error(
        `Failed to generate signed URL for Google Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "generate signed URL for Google Cloud Storage");
    }
  }

  public async getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    const { path, ttlSeconds, contentType } = params;

    try {
      const file = this.bucket.file(path);

      const options: GetSignedUrlConfig = {
        version: "v4",
        action: "write",
        expires: Date.now() + ttlSeconds * 1000,
        contentType,
        extensionHeaders: {
          "Content-Length": params.contentLength.toString(),
        },
      };

      const [url] = await file.getSignedUrl(options);
      return url;
    } catch (err) {
      logger.error(
        `Failed to generate signed upload URL for Google Cloud Storage ${path}`,
        err,
      );
      handleStorageError(
        err,
        "generate signed upload URL for Google Cloud Storage",
      );
    }
  }

  public async deleteFiles(paths: string[]): Promise<void> {
    try {
      await Promise.all(
        paths.map(async (path) => {
          const file = this.bucket.file(path);
          await file.delete({ ignoreNotFound: true });
        }),
      );
    } catch (err) {
      logger.error(`Failed to delete files from Google Cloud Storage`, err);
      handleStorageError(err, "delete files from Google Cloud Storage");
    }
  }
}

class OracleCloudStorageService implements StorageService {
  private client: objectstorage.ObjectStorageClient;
  private namespace: string | null = null;
  private bucketName: string;
  private region: string | undefined;

  constructor(params: {
    bucketName: string;
    region: string | undefined;
    oracleCloudCredentials?: string;
    accessKeyId?: string | undefined;
    secretAccessKey?: string | undefined;
  }) {
    this.bucketName = params.bucketName;
    this.region = params.region;

    // Determine region - use provided region or default
    const regionId = params.region || "us-phoenix-1";
    const region = common.Region.fromRegionId(regionId);

    // Use Instance Principal authentication - automatically grabs credentials from instance metadata
    // Equivalent to Python: signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
    // This automatically grabs credentials when running on an OCI instance - no manual config needed
    const authenticationDetailsProvider =
      new common.InstancePrincipalsAuthenticationDetailsProvider();
    logger.info("Using Instance Principal authentication for Oracle Cloud Storage (auto-detected)");

    // Initialize the Object Storage client with region config
    // Equivalent to Python: object_storage_client = oci.object_storage.ObjectStorageClient(config={"region": "us-phoenix-1"})
    this.client = new objectstorage.ObjectStorageClient({
      authenticationDetailsProvider: authenticationDetailsProvider,
    });

    // Get namespace asynchronously
    this.getNamespace();
  }

  private async getNamespace(): Promise<void> {
    if (this.namespace) {
      return;
    }
    try {
      const getNamespaceRequest: objectstorage.requests.GetNamespaceRequest = {};
      const response = await this.client.getNamespace(getNamespaceRequest);
      this.namespace = response.value;
    } catch (err) {
      logger.error("Failed to get Oracle Cloud Storage namespace", err);
      handleStorageError(err, "get Oracle Cloud Storage namespace");
    }
  }

  private async ensureNamespace(): Promise<string> {
    if (!this.namespace) {
      await this.getNamespace();
    }
    if (!this.namespace) {
      throw new Error("Failed to retrieve Oracle Cloud Storage namespace");
    }
    return this.namespace;
  }

  public async uploadFile({
    fileName,
    fileType,
    data,
  }: UploadFile): Promise<void> {
    try {
      const namespace = await this.ensureNamespace();

      let content: Buffer;
      if (typeof data === "string") {
        content = Buffer.from(data, "utf-8");
      } else if (data instanceof Readable) {
        // Convert stream to buffer
        const chunks: Buffer[] = [];
        for await (const chunk of data) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        content = Buffer.concat(chunks);
      } else {
        throw new Error("Unsupported data type. Must be Readable or string.");
      }

      const putObjectRequest: objectstorage.requests.PutObjectRequest = {
        namespaceName: namespace,
        bucketName: this.bucketName,
        objectName: fileName,
        putObjectBody: content,
        contentLength: content.length,
        contentType: fileType,
      };

      await this.client.putObject(putObjectRequest);
    } catch (err) {
      logger.error(
        `Failed to upload file to Oracle Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Oracle Cloud Storage");
    }
  }

  public async uploadWithSignedUrl({
    fileName,
    fileType,
    data,
    expiresInSeconds,
  }: UploadWithSignedUrl): Promise<{ signedUrl: string }> {
    try {
      await this.uploadFile({ fileName, data, fileType });
      const signedUrl = await this.getSignedUrl(fileName, expiresInSeconds);
      return { signedUrl };
    } catch (err) {
      logger.error(
        `Failed to upload file to Oracle Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(err, "upload file to Oracle Cloud Storage");
    }
  }

  public async uploadJson(
    path: string,
    body: Record<string, unknown>[],
  ): Promise<void> {
    try {
      const namespace = await this.ensureNamespace();
      const content = JSON.stringify(body);
      const contentBuffer = Buffer.from(content, "utf-8");

      const putObjectRequest: objectstorage.requests.PutObjectRequest = {
        namespaceName: namespace,
        bucketName: this.bucketName,
        objectName: path,
        putObjectBody: contentBuffer,
        contentLength: contentBuffer.length,
        contentType: "application/json",
      };

      await this.client.putObject(putObjectRequest);
    } catch (err) {
      logger.error(
        `Failed to upload JSON to Oracle Cloud Storage ${path}`,
        err,
      );
      handleStorageError(err, "upload JSON to Oracle Cloud Storage");
    }
  }

  public async download(path: string): Promise<string> {
    try {
      const namespace = await this.ensureNamespace();

      const getObjectRequest: objectstorage.requests.GetObjectRequest = {
        namespaceName: namespace,
        bucketName: this.bucketName,
        objectName: path,
      };

      const response = await this.client.getObject(getObjectRequest);
      const chunks: Buffer[] = [];

      if (response.value) {
        for await (const chunk of response.value) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      }

      return Buffer.concat(chunks).toString("utf-8");
    } catch (err) {
      logger.error(
        `Failed to download file from Oracle Cloud Storage ${path}`,
        err,
      );
      handleStorageError(err, "download file from Oracle Cloud Storage");
    }
  }

  public async listFiles(
    prefix: string,
  ): Promise<{ file: string; createdAt: Date }[]> {
    try {
      const namespace = await this.ensureNamespace();

      const listObjectsRequest: objectstorage.requests.ListObjectsRequest = {
        namespaceName: namespace,
        bucketName: this.bucketName,
        prefix: prefix,
        limit: env.LANGFUSE_S3_LIST_MAX_KEYS,
      };

      const response = await this.client.listObjects(listObjectsRequest);
      const files: { file: string; createdAt: Date }[] = [];

      if (response.listObjects?.objects) {
        for (const object of response.listObjects.objects) {
          if (object.name && object.name.startsWith(prefix)) {
            files.push({
              file: object.name,
              createdAt: object.timeCreated
                ? new Date(object.timeCreated)
                : new Date(),
            });
          }
        }
      }

      return files;
    } catch (err) {
      logger.error(
        `Failed to list files from Oracle Cloud Storage ${prefix}`,
        err,
      );
      handleStorageError(err, "list files from Oracle Cloud Storage");
    }
  }

  public async getSignedUrl(
    fileName: string,
    ttlSeconds: number,
    asAttachment: boolean = false,
  ): Promise<string> {
    try {
      const namespace = await this.ensureNamespace();

      const createPreauthenticatedRequestDetails: objectstorage.models.CreatePreauthenticatedRequestDetails =
        {
          name: `signed-url-${Date.now()}`,
          objectName: fileName,
          accessType:
            objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType
              .ObjectRead,
          timeExpires: new Date(Date.now() + ttlSeconds * 1000),
        };

      const createPreauthenticatedRequest: objectstorage.requests.CreatePreauthenticatedRequestRequest =
        {
          namespaceName: namespace,
          bucketName: this.bucketName,
          createPreauthenticatedRequestDetails:
            createPreauthenticatedRequestDetails,
        };

      const response =
        await this.client.createPreauthenticatedRequest(
          createPreauthenticatedRequest,
        );

      if (!response.preauthenticatedRequest?.accessUri) {
        throw new Error("Failed to generate signed URL");
      }

      // Construct the full URL
      // The accessUri from OCI already includes the full path, we just need to prepend the base URL
      const regionId = this.region || "us-ashburn-1";
      const baseUrl = `https://objectstorage.${regionId}.oraclecloud.com`;
      let url = `${baseUrl}${response.preauthenticatedRequest.accessUri}`;

      // Add content disposition if attachment is requested
      if (asAttachment) {
        const separator = url.includes("?") ? "&" : "?";
        url = `${url}${separator}response-content-disposition=attachment%3B%20filename%3D%22${encodeURIComponent(fileName)}%22`;
      }

      return url;
    } catch (err) {
      logger.error(
        `Failed to generate signed URL for Oracle Cloud Storage ${fileName}`,
        err,
      );
      handleStorageError(
        err,
        "generate signed URL for Oracle Cloud Storage",
      );
    }
  }

  public async getSignedUploadUrl(params: {
    path: string;
    ttlSeconds: number;
    sha256Hash: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    const { path, ttlSeconds, contentType } = params;
    try {
      const namespace = await this.ensureNamespace();

      const createPreauthenticatedRequestDetails: objectstorage.models.CreatePreauthenticatedRequestDetails =
        {
          name: `signed-upload-url-${Date.now()}`,
          objectName: path,
          accessType:
            objectstorage.models.CreatePreauthenticatedRequestDetails.AccessType
              .ObjectWrite,
          timeExpires: new Date(Date.now() + ttlSeconds * 1000),
        };

      const createPreauthenticatedRequest: objectstorage.requests.CreatePreauthenticatedRequestRequest =
        {
          namespaceName: namespace,
          bucketName: this.bucketName,
          createPreauthenticatedRequestDetails:
            createPreauthenticatedRequestDetails,
        };

      const response =
        await this.client.createPreauthenticatedRequest(
          createPreauthenticatedRequest,
        );

      if (!response.preauthenticatedRequest?.accessUri) {
        throw new Error("Failed to generate signed upload URL");
      }

      // Construct the full URL
      // The accessUri from OCI already includes the full path, we just need to prepend the base URL
      const regionId = this.region || "us-ashburn-1";
      const baseUrl = `https://objectstorage.${regionId}.oraclecloud.com`;
      let url = `${baseUrl}${response.preauthenticatedRequest.accessUri}`;

      // Add content type header
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}Content-Type=${encodeURIComponent(contentType)}`;

      return url;
    } catch (err) {
      logger.error(
        `Failed to generate signed upload URL for Oracle Cloud Storage ${path}`,
        err,
      );
      handleStorageError(
        err,
        "generate signed upload URL for Oracle Cloud Storage",
      );
    }
  }

  public async deleteFiles(paths: string[]): Promise<void> {
    await backOff(() => this.deleteFilesNonRetrying(paths), {
      numOfAttempts: 3,
    });
  }

  async deleteFilesNonRetrying(paths: string[]): Promise<void> {
    try {
      const namespace = await this.ensureNamespace();

      await Promise.all(
        paths.map(async (path) => {
          const deleteObjectRequest: objectstorage.requests.DeleteObjectRequest =
            {
              namespaceName: namespace,
              bucketName: this.bucketName,
              objectName: path,
            };
          await this.client.deleteObject(deleteObjectRequest);
        }),
      );
    } catch (err) {
      logger.error(
        `Failed to delete files from Oracle Cloud Storage ${paths}`,
        err,
      );
      handleStorageError(err, "delete files from Oracle Cloud Storage");
    }
  }
}
