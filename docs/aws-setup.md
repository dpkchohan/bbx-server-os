# AWS setup

This covers the IAM permissions, S3 bucket layout, and service setup needed
for the example jobs in `/jobs` (transcription, translation, Bedrock
summarization) to work against real AWS services from EC2 instance
`i-0ca603e4ef9deb7f9` (`100.31.146.20`).

## Recommended: use an EC2 instance role, not access keys

The compose file lets you set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
in `.env`, but the strongly preferred approach is to **attach an IAM role to
the EC2 instance** and leave those two variables blank. The AWS SDK
(`@aws-sdk/*` used in `/jobs`) automatically picks up credentials from the
instance metadata service — no secrets to rotate, leak, or bake into `.env`.

```bash
# One-time, from your local machine with AWS CLI configured:
aws iam create-role --role-name bbx-server-os-task-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam put-role-policy --role-name bbx-server-os-task-role \
  --policy-name bbx-server-os-policy \
  --policy-document file://iam-policy.json   # see below

aws iam create-instance-profile --instance-profile-name bbx-server-os-profile
aws iam add-role-to-instance-profile \
  --instance-profile-name bbx-server-os-profile \
  --role-name bbx-server-os-task-role

aws ec2 associate-iam-instance-profile \
  --instance-id i-0ca603e4ef9deb7f9 \
  --iam-instance-profile Name=bbx-server-os-profile
```

Because the supervisor runs task containers via the Docker daemon on the
same host, credentials resolved from the instance metadata service are
available inside every task container too (the AWS SDK's default credential
provider chain reaches IMDS transparently) — no extra plumbing needed beyond
setting `AWS_REGION` in `.env`.

Note: this instance currently has **IMDSv2 required** (see instance
summary) — the AWS SDK v3 clients used in `/jobs` support IMDSv2
automatically, no extra config needed.

## IAM policy

Save as `iam-policy.json` and attach to the instance role (or a dedicated
IAM user if you must use access keys). Replace the bucket name if you don't
use the default `bbx-chat-gsfc-media`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-*",
        "arn:aws:bedrock:*::foundation-model/amazon.nova-*"
      ]
    },
    {
      "Sid": "BedrockListModels",
      "Effect": "Allow",
      "Action": ["bedrock:ListFoundationModels", "bedrock:GetFoundationModel"],
      "Resource": "*"
    },
    {
      "Sid": "TranscribeJobs",
      "Effect": "Allow",
      "Action": [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
        "transcribe:ListTranscriptionJobs",
        "transcribe:DeleteTranscriptionJob"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TranslateText",
      "Effect": "Allow",
      "Action": ["translate:TranslateText", "translate:TranslateDocument"],
      "Resource": "*"
    },
    {
      "Sid": "SESSendMagicLinkEmails",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
    },
    {
      "Sid": "S3MediaBucketAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::bbx-chat-gsfc-media/*"
    },
    {
      "Sid": "S3MediaBucketList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::bbx-chat-gsfc-media"
    }
  ]
}
```

Notes:
- `transcribe:*` and `translate:TranslateText` do not support resource-level
  ARN scoping for these particular actions, so `Resource: "*"` is required
  (this matches AWS's own managed policies for these services).
- Bedrock model ARNs are scoped to specific model family prefixes rather
  than `foundation-model/*`, per AWS's guidance for limiting blast radius of
  model access. Add more `Resource` entries if you use additional models.
- If Amazon Transcribe writes its own output directly to your bucket (as the
  `transcribe-meeting` task does via `OutputBucketName`), this is handled
  automatically by AWS for jobs that specify `OutputBucketName` directly —
  no extra bucket policy needed, unlike cross-account setups.

## S3 bucket structure

Single bucket, prefixed by purpose, matching the paths the example jobs
read/write:

```
bbx-chat-gsfc-media/
├── recordings/            # Raw meeting audio/video uploaded by the bot
│   └── mtg_<id>.mp4
├── transcripts/           # Amazon Transcribe JSON output
│   └── bbx-mtg_<id>-<timestamp>.json
├── translations/          # Plain-text translated transcripts
│   └── <lang>-bbx-mtg_<id>-<timestamp>.json
└── summaries/             # Bedrock-generated JSON summaries + action items
    └── mtg_<id>.json
```

Create it with:

```bash
aws s3 mb s3://bbx-chat-gsfc-media --region us-east-1

# Block all public access - this bucket holds meeting content
aws s3api put-public-access-block \
  --bucket bbx-chat-gsfc-media \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Optional: lifecycle rule to expire old recordings after 90 days
aws s3api put-bucket-lifecycle-configuration \
  --bucket bbx-chat-gsfc-media \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-old-recordings",
      "Filter": { "Prefix": "recordings/" },
      "Status": "Enabled",
      "Expiration": { "Days": 90 }
    }]
  }'
```

Set `BBX_S3_BUCKET=bbx-chat-gsfc-media` in `.env` to match.

## Amazon Bedrock model access

Bedrock requires explicitly enabling access to each foundation model family
per-account, per-region, before `InvokeModel` will succeed:

1. AWS Console → Bedrock → **Model access** (left sidebar) → **Modify model
   access**.
2. Enable **Anthropic Claude 3.5 Sonnet** (used by `summarize-with-bedrock`
   by default) and/or **Amazon Nova** models if you prefer a lower-cost
   alternative.
3. Submit — for most models in `us-east-1` this is instant; some
   third-party models require a brief use-case questionnaire.
4. Set `BBX_BEDROCK_MODEL_ID` in `.env` to the exact model ID you enabled,
   e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0` or
   `amazon.nova-lite-v1:0`.

## Amazon Transcribe setup

No pre-provisioning needed beyond IAM — `StartTranscriptionJobCommand` is
called directly by the `transcribe-meeting` task with the source file
already in S3 (`MediaFileUri`) and results written back to
`OutputBucketName`. Set `BBX_TRANSCRIBE_LANGUAGE_CODE` in `.env` (default
`en-US`); see the
[supported languages list](https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html)
if your meetings aren't in English.

## Amazon Translate setup

No pre-provisioning needed — `TranslateTextCommand` is called directly.
Set `BBX_TRANSLATE_SOURCE_LANGUAGE` / `BBX_TRANSLATE_TARGET_LANGUAGE` in
`.env` (defaults `en` → `es`). Amazon Translate auto-detects the source
language if you omit `SourceLanguageCode` (set it to `auto` if needed).

## Cost estimate (light internal usage)

Assuming ~20 meetings/month, averaging 45 minutes each:

| Service | Unit cost | Monthly volume | Est. monthly cost |
|---|---|---|---|
| Amazon Transcribe | $0.024/min | 900 min | ~$21.60 |
| Amazon Translate | $15/million chars | ~2M chars (transcripts) | ~$30.00 |
| Amazon Bedrock (Claude 3.5 Sonnet) | ~$3/$15 per 1M in/out tokens | ~20 summaries, ~15K tokens each | ~$3-6 |
| S3 storage | $0.023/GB-month | ~10 GB (recordings+artifacts) | ~$0.25 |
| EC2 (t2.large, on-demand, us-east-1) | ~$0.0928/hr | 730 hrs | ~$67.70 |
| EBS (gp3, assume 30GB) | ~$0.08/GB-month | 30 GB | ~$2.40 |
| **Total** | | | **~$125-130/month** |

Switching the EC2 instance to a 1-year Reserved Instance or Savings Plan
would cut the ~$68/month compute cost roughly in half. Transcribe/Translate/
Bedrock costs scale linearly with actual usage — the numbers above are
rough planning estimates, not a guarantee.

