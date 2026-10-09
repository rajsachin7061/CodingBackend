# Daily challenge email deployment

The backend sends the existing **published** Resend template once per day at
07:00 in `Asia/Kolkata`. It fetches the template's declared variables through
the Resend API and never creates or edits a template. Existing accounts remain
opted out: the `dailyChallengeEmailOptIn` Mongoose field defaults to `false`.
Users can opt in during registration or change the preference on their profile.

## Backend environment

Set these values in the backend deployment environment (and in
`CodingBackend/.env` for local development):

| Variable | Required value |
| --- | --- |
| `MONGODB_URI` | Existing Atlas connection string; backend only. |
| `MONGODB_DB_NAME` | Existing database name (currently defaults to `online_quiz`). |
| `RESEND_API_KEY` | Resend API key, backend only. |
| `RESEND_TEMPLATE_ID` | ID of the existing **published** daily challenge template. |
| `EMAIL_FROM` | Verified Resend sender, e.g. `CodeSnipers <noreply@codesnipers.in>`. |
| `DAILY_EMAIL_PUBLIC_URL` | Public backend origin used to build signed unsubscribe links. |
| `EMAIL_UNSUBSCRIBE_SECRET` | Stable random secret of at least 32 characters. Keep it private and do not rotate casually; old unsubscribe links rely on it. |
| `DAILY_EMAIL_ENABLED` | Set to `true` to start the production scheduler; otherwise it is disabled. |
| `DAILY_EMAIL_DRY_RUN` | Keep `true` until ready for sending. Set to `false` to permit scheduled live delivery. |
| `RESEND_WEBHOOK_SECRET` | Optional. Signing secret for the Resend webhook described below. |

`EMAIL_FROM` is also used by existing registration/password email sending. The
backend continues to accept the legacy `RESEND_FROM` setting as a fallback so
existing deployments are not broken.

### Template variables and unsubscribe

At job start, the backend reads the variable keys and fallback values from the
published template. It fills recognized name, email, date, and unsubscribe
variables only when declared by that template. Any required, unmapped variable
with no fallback causes a clear configuration error before messages are sent.

For custom variable names, optionally set `RESEND_TEMPLATE_VARIABLE_MAP` to a
JSON object whose keys are **exact variable keys from the Resend template** and
whose values are one of `name`, `email`, `unsubscribeUrl`, or `scheduledDate`.
For example:

```text
RESEND_TEMPLATE_VARIABLE_MAP={"firstName":"name","unsubscribe_link":"unsubscribeUrl"}
```

For a visible in-body unsubscribe link, the existing template should declare a
string variable such as `unsubscribe_link` and use it as its link target. The
backend also sends RFC 8058 `List-Unsubscribe` headers and serves signed
`GET`/one-click `POST` unsubscribe requests at
`/api/email/unsubscribe?token=...`; the link updates the existing user's
preference to opted out. No template content is changed by the backend.

Resend API acceptance is recorded as `accepted`, not `delivered`. A transport
failure with an unknown outcome is recorded as `uncertain` and is not retried
blindly. An explicit Resend API error is recorded as `failed`. MongoDB's unique
index on `(userId, emailType, scheduledDate)`, Resend idempotency keys, and a
persistent per-day worker lock protect against duplicate sends across backend
instances. No automatic retry re-sends an already reserved recipient.

To update status when Resend confirms delivery, configure a Resend webhook for
`email.delivered`, `email.bounced`, `email.failed`, `email.complained`, and
`email.suppressed` events at
`https://<your-backend-host>/api/email/resend-webhook`, then set
`RESEND_WEBHOOK_SECRET` to the signing secret shown by Resend. The endpoint
verifies Svix signatures against the raw request body and updates only matching
daily-challenge sends. Without this optional webhook, successful send records
remain `accepted` and are not represented as delivered.
The batch's `succeeded` count means Resend accepted the send request; only a
verified `email.delivered` webhook changes the persistent status to `delivered`.

## Install, test, and deploy

No new npm dependency is required. From PowerShell:

```powershell
Set-Location .\CodingBackend
npm ci
npm test
npm run daily-email -- --dry-run
```

The dry run connects to MongoDB, reads the configured template and eligible
users, and logs projected counts without sending or reserving recipient
records. For a single real template test, set `DAILY_EMAIL_TEST_RECIPIENT` to
an address you control and run:

```powershell
npm run daily-email -- --send-test
```

This sends one message to that explicit test address, not to the user list.
Confirm the published template ID, sender verification, variables, and rendered
message in Resend before enabling the batch.

In the backend deployment dashboard, configure all values above, then set
`DAILY_EMAIL_ENABLED=true` and `DAILY_EMAIL_DRY_RUN=false`. Deploy/restart the
backend. The scheduler starts only after its MongoDB connection succeeds; every
instance calculates the next 07:00 Asia/Kolkata run, while MongoDB atomically
allows only one instance to claim that day's job. If a backend starts after
07:00, it attempts that day's run once; the lock prevents repeats. To make a deliberate manual
batch run, use `npm run daily-email -- --run-now` only after both live flags
are set; without them the command remains a dry run.

Verify production by checking backend logs for the scheduled 07:00 IST run and
its attempted/succeeded/failed/skipped counts, then inspect the backend
`dailyemailtrackings` collection for each eligible recipient's Resend ID and
`accepted`, `failed`, or `uncertain` status. Verify a test recipient's
unsubscribe link changes that user's `dailyChallengeEmailOptIn` to `false`.
Keep the separate registration workflow unchanged.

Before enabling sends, confirm in the Resend dashboard that `RESEND_TEMPLATE_ID`
is the intended published template, all required template variables either
have a fallback or are covered by the mapping, and `EMAIL_FROM` is verified.
Those dashboard values cannot be discovered from this repository.
