# Cloudswift Email Campaign

Paced bulk email campaigns on Amazon SES. Built for Lexara's Michigan Bar outreach first, then reusable for any list.

## What it does

- Sends to a list at a configurable rate per hour, with live rate changes, pause, and resume.
- Works through a list exactly once per recipient; restarts never duplicate sends.
- Owns its own unsubscribe service (one-click RFC 8058, landing page, mailto).
- Keeps every SES event, unsubscribe event, and dispatcher event in one event lake.
- Auto-pauses on bounce/complaint threshold breaches.
- Warms new sending identities automatically per mailbox provider using measured placement and health gates (no fake engagement).
- Designed to meet Gmail/Yahoo bulk-sender rules.

## First sending domain

`lexara.vip` — sending as `Amy … <amy@lexara.vip>` with replies to `amy@lexara.com`.

## Architecture

- AWS CDK (TypeScript), serverless.
- Amazon SES v2 with domain identity, Easy DKIM, custom MAIL FROM.
- DynamoDB for campaign, recipient, suppression, and warm-up state.
- S3 + Firehose + Glue/Athena for the event lake.
- Lambda functions for import, dispatch, event processing, unsubscribe handling, and warm-up control.
- API Gateway HTTP API for unsubscribe endpoints.
- SES inbound for mailto unsubscribes and DMARC reports.

## Repository layout

```
lib/
  cloudswift-email-campaign-stack.ts   # Main CDK stack
  constructs/
    ses-foundation.ts                  # SES identity + config set + event destinations
    data-layer.ts                      # DynamoDB tables + S3 + Firehose + Glue
    unsubscribe-service.ts             # API Gateway + Lambda (Phase 2)
    dispatcher.ts                      # Scheduler + Dispatcher Lambda (Phase 3)
    warmup-service.ts                  # Warm-up controller + placement monitor (Phase 4)
lambda/
  import/       # List import Lambda
  dispatcher/   # Send dispatcher Lambda
  events/       # SES event processor
  unsub/        # Unsubscribe/Subscribe handlers
  mailto/       # SES inbound mailto parser
  warmup/       # Warm-up controller
  seeds/        # Seed mailbox monitor
bin/
  cloudswift-email-campaign.ts         # CDK entry point
cli/          # Control CLI (Phase 5)
```

## Deploy profile

```bash
export AWS_PROFILE=deploy_super_prod
npx cdk bootstrap
npx cdk deploy
```

## Status

Phase 1 in progress: SES foundation, data layer, event lake.

## Decisions

| # | Decision | Value |
|---|---|---|
| 1 | AWS account / region | `deploy_super_prod` profile, `us-east-1` |
| 2 | Domain | `lexara.vip`; `lexara.com` unchanged |
| 3 | From / Reply-To | `amy@lexara.vip` / `amy@lexara.com` |
| 4 | Postal address | 500 W. Hickman #318, Waukee, IA 50263, "Lexara" |
| 5 | Unsubscribe permanence | Permanent until explicit subscribe event |
| 6 | Send window | Mon–Fri 08:00–17:00 America/Detroit |
| 7 | Address validation | SES Email Validation at import + Auto Validation at send |
| 8 | SmartReach volume | Configurable per sending domain |

## Next steps

1. Request SES production access for account `474741569542` in `us-east-1`.
2. Add Cloudflare DNS records from stack outputs.
3. Verify DKIM and MAIL FROM.
4. Seed-test one-click, landing-page, and mailto unsubscribe paths.
