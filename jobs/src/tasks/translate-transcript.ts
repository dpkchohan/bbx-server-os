import { task, logger } from "@trigger.dev/sdk";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";

/**
 * translate-transcript
 *
 * Reads a completed Amazon Transcribe JSON transcript from S3, extracts the
 * plain-text transcript, translates it with Amazon Translate, and writes the
 * translated text back to S3 under `translations/`.
 *
 * Designed to be chained after transcribe-meeting, e.g.:
 *   const { transcriptUri } = await transcribeMeeting.triggerAndWait(...);
 *   await translateTranscript.trigger({ transcriptUri, targetLanguage: "es" });
 */

type TranslateTranscriptPayload = {
  transcriptUri: string; // s3://bucket/key of the Transcribe JSON output
  sourceLanguage?: string; // defaults to BBX_TRANSLATE_SOURCE_LANGUAGE
  targetLanguage?: string; // defaults to BBX_TRANSLATE_TARGET_LANGUAGE
};

const REGION = process.env.AWS_REGION ?? "us-east-1";

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

export const translateTranscript = task({
  id: "translate-transcript",
  // small-1x (0.5 vCPU / 0.5GB) is plenty — this task just shuttles text
  // through the Translate API, no heavy local processing.
  machine: "small-1x",
  maxDuration: 600, // 10 minutes
  run: async (payload: TranslateTranscriptPayload) => {
    const s3 = new S3Client({ region: REGION });
    const translate = new TranslateClient({ region: REGION });

    const { bucket, key } = parseS3Uri(payload.transcriptUri);
    logger.info("Fetching transcript from S3", { bucket, key });

    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const raw = await object.Body?.transformToString();
    if (!raw) throw new Error("Transcript object body was empty");

    const transcriptJson = JSON.parse(raw);
    const transcriptText: string | undefined =
      transcriptJson?.results?.transcripts?.[0]?.transcript;

    if (!transcriptText) {
      throw new Error("Could not find transcript text in Transcribe output JSON");
    }

    const sourceLanguage =
      payload.sourceLanguage ?? process.env.BBX_TRANSLATE_SOURCE_LANGUAGE ?? "en";
    const targetLanguage =
      payload.targetLanguage ?? process.env.BBX_TRANSLATE_TARGET_LANGUAGE ?? "es";

    // Amazon Translate's synchronous TranslateText caps at 10,000 bytes per
    // request, so chunk long transcripts and stitch the results back together.
    const MAX_BYTES = 9000;
    const chunks = chunkText(transcriptText, MAX_BYTES);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
      const result = await translate.send(
        new TranslateTextCommand({
          Text: chunk,
          SourceLanguageCode: sourceLanguage,
          TargetLanguageCode: targetLanguage,
        })
      );
      translatedChunks.push(result.TranslatedText ?? "");
    }

    const translatedText = translatedChunks.join(" ");
    const outputKey = key.replace("transcripts/", `translations/${targetLanguage}-`);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: outputKey,
        Body: translatedText,
        ContentType: "text/plain; charset=utf-8",
      })
    );

    logger.info("Wrote translated transcript", { bucket, outputKey, targetLanguage });

    return {
      translatedUri: `s3://${bucket}/${outputKey}`,
      sourceLanguage,
      targetLanguage,
      characterCount: translatedText.length,
    };
  },
});

function chunkText(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (Buffer.byteLength(current + sentence, "utf-8") > maxBytes) {
      if (current) chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
