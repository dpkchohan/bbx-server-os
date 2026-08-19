import { task, logger } from "@trigger.dev/sdk";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * summarize-with-bedrock
 *
 * Reads a plain-text meeting transcript from S3, sends it to an Amazon
 * Bedrock foundation model (Claude by default) for a structured summary +
 * action items, and writes the result back to S3 as JSON.
 *
 * Trigger example:
 *   await tasks.trigger("summarize-with-bedrock", {
 *     transcriptTextUri: "s3://bbx-chat-gsfc-media/translations/es-mtg_12345.txt",
 *     meetingId: "mtg_12345",
 *   });
 */

type SummarizePayload = {
  meetingId: string;
  transcriptTextUri: string; // s3://bucket/key of a plain-text transcript
};

const REGION = process.env.AWS_REGION ?? "us-east-1";
const MODEL_ID =
  process.env.BBX_BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-sonnet-20241022-v2:0";

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

export const summarizeWithBedrock = task({
  id: "summarize-with-bedrock",
  // medium-1x (1 vCPU / 2GB) - the task itself is lightweight (an HTTP call),
  // but keeps headroom for larger transcripts / JSON parsing.
  machine: "medium-1x",
  maxDuration: 300, // 5 minutes
  run: async (payload: SummarizePayload) => {
    const s3 = new S3Client({ region: REGION });
    const bedrock = new BedrockRuntimeClient({ region: REGION });

    const { bucket, key } = parseS3Uri(payload.transcriptTextUri);
    logger.info("Fetching transcript text from S3", { bucket, key });

    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const transcriptText = await object.Body?.transformToString();
    if (!transcriptText) throw new Error("Transcript text object was empty");

    const prompt = `You are an assistant summarizing a meeting transcript for BBX Chat GSFC.
Produce a JSON object with keys "summary" (2-4 sentence overview), "keyPoints"
(array of strings) and "actionItems" (array of { owner, task } objects, owner
may be "unassigned" if unclear). Respond with ONLY the JSON object, no markdown.

Transcript:
${transcriptText}`;

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });

    logger.info("Invoking Bedrock model", { modelId: MODEL_ID });

    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body,
      })
    );

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const rawText: string = responseBody.content?.[0]?.text ?? "{}";

    let summaryJson: unknown;
    try {
      summaryJson = JSON.parse(rawText);
    } catch {
      logger.warn("Model did not return valid JSON, storing raw text instead", {
        rawText,
      });
      summaryJson = { summary: rawText, keyPoints: [], actionItems: [] };
    }

    const outputKey = `summaries/${payload.meetingId}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: JSON.stringify(summaryJson, null, 2),
        ContentType: "application/json",
      })
    );

    logger.info("Wrote meeting summary", { bucket, outputKey });

    return {
      meetingId: payload.meetingId,
      summaryUri: `s3://${bucket}/${outputKey}`,
      modelId: MODEL_ID,
    };
  },
});
