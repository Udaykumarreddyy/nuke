/**
 * S3 Uploader — Uploads HTML reports to the reports bucket
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

export async function uploadReport(
  htmlContent: string,
  reportType: "scan" | "cleanup"
): Promise<string> {
  const bucket = process.env.REPORT_BUCKET;
  if (!bucket) throw new Error("REPORT_BUCKET not set");

  const today = new Date().toISOString().split("T")[0];
  const key = `reports/${today}/${reportType}-report.html`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: htmlContent,
      ContentType: "text/html",
      Metadata: {
        "generated-by": "aws-resource-nuke",
        "report-type": reportType,
        "scan-date": today,
      },
    })
  );

  return `s3://${bucket}/${key}`;
}
