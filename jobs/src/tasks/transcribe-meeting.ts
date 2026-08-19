import { task, logger } from "@trigger.dev/sdk";
import {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand,
} from "@aws-sdk/client-transcribe";

/**
 * transcribe-meeting
 *
 * Takes a recorded meeting audio/video file already uploaded to S3 and runs
 * it through Amazon Transcribe, polling until the job completes. The output
 * transcript JSON is written by Transcribe to the same bucket under
 * `transcripts/<jobName>.json`.
 *
 * Trigger example (from your backend):
 *   await tasks.trigger("transcribe-meeting", {
 *     meetingId: "mtg_12345",
 *     s3Uri: "s3://bbx-chat-gsfc-media/recordings/mtg_12345.mp4",
 *     languageCode: "en-US",
 *   });
 */

type TranscribeMeetingPayload = {
  meetingId: string;
  s3Uri: string; // s3://bucket/key of the source recording
  languageCode?: string; // defaults to BBX_TRANSCRIBE_LANGUAGE_CODE
};

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.BBX_S3_BUCKET;

export const transcribeMeeting = task({
  id: "transcribe-meeting",
  // small-2x gives this task 1 vCPU / 1GB — Transcribe calls are I/O bound,
  // most of the wait is polling, not local compute.
  machine: "small-2x",
  maxDuration: 1800, // 30 minutes ceiling for very long meetings
  run: async (payload: TranscribeMeetingPayload) => {
    if (!BUCKET) {
      throw new Error("BBX_S3_BUCKET is not configured (see .env.example)");
    }

    const client = new TranscribeClient({ region: REGION });
    const jobName = `bbx-${payload.meetingId}-${Date.now()}`;
    const languageCode =
      payload.languageCode ?? process.env.BBX_TRANSCRIBE_LANGUAGE_CODE ?? "en-US";

    logger.info("Starting transcription job", { jobName, s3Uri: payload.s3Uri });

    await client.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: languageCode as any,
        Media: { MediaFileUri: payload.s3Uri },
        OutputBucketName: BUCKET,
        OutputKey: `transcripts/${jobName}.json`,
      })
    );

    // Poll for completion. Trigger.dev retries/wait mechanisms keep this
    // cheap — the task process sleeps between checks rather than busy-looping.
    const POLL_INTERVAL_MS = 10_000;
    const MAX_POLLS = 120; // 20 minutes of polling before giving up

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const { TranscriptionJob } = await client.send(
        new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
      );

      const status = TranscriptionJob?.TranscriptionJobStatus;
      logger.info("Polled transcription job", { jobName, status, attempt });

      if (status === "COMPLETED") {
        return {
          meetingId: payload.meetingId,
          jobName,
          transcriptUri: `s3://${BUCKET}/transcripts/${jobName}.json`,
          languageCode,
        };
      }

      if (status === "FAILED") {
        throw new Error(
          `Transcription job ${jobName} failed: ${TranscriptionJob?.FailureReason}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Transcription job ${jobName} did not complete in time`);
  },
});
