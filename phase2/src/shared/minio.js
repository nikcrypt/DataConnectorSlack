import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { minioConfig } from "./config.js";

export function createS3Client() {
  const cfg = minioConfig();
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  return { client, cfg };
}

export async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putJsonl(client, bucket, key, lines) {
  const body = lines.length ? `${lines.join("\n")}\n` : "";
  const bytes = Buffer.byteLength(body, "utf8");
  const contentHash = createHash("sha256").update(body).digest("hex");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/x-ndjson",
    })
  );
  return {
    uri: `s3://${bucket}/${key}`,
    bytes,
    record_count: lines.length,
    content_hash: contentHash,
  };
}
