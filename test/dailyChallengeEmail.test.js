import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTemplateVariables,
  applyResendWebhookEvent,
  DAILY_EMAIL_TIME_ZONE,
  getNextDailyRunAt,
  getScheduledDate,
  isValidEmail,
  processDailyChallengeUsers,
  runDailyChallengeJob,
  sendTemplateEmail,
  verifyUnsubscribeToken,
} from "../server/dailyChallengeEmail.js";
import { DailyEmailTracking, User } from "../server/db.js";

const silentLogger = {
  error() {},
  info() {},
};

test("formats the scheduled day and next run in Asia/Kolkata", () => {
  assert.equal(DAILY_EMAIL_TIME_ZONE, "Asia/Kolkata");
  assert.equal(getScheduledDate(new Date("2026-10-08T20:00:00.000Z")), "2026-10-09");
  assert.equal(
    getNextDailyRunAt(new Date("2026-10-08T20:00:00.000Z")).toISOString(),
    "2026-10-09T01:30:00.000Z",
  );
  assert.equal(
    getNextDailyRunAt(new Date("2026-10-09T01:30:00.000Z")).toISOString(),
    "2026-10-10T01:30:00.000Z",
  );
});

test("populates only declared template variables mapped to known user data", () => {
  const variables = buildTemplateVariables({
    variableMap: new Map([
      ["first_name", "name"],
      ["unsubscribe_link", "unsubscribeUrl"],
    ]),
    user: { name: "Asha", email: "asha@example.com" },
    unsubscribeUrl: "https://codesniper.in/api/email/unsubscribe?token=abc",
    scheduledDate: "2026-10-09",
  });

  assert.deepEqual(variables, {
    first_name: "Asha",
    unsubscribe_link: "https://codesniper.in/api/email/unsubscribe?token=abc",
  });
});

test("sends the published template with its declared variables and signed unsubscribe URL", async () => {
  const savedSecret = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret-with-at-least-32-characters";
  const calls = [];
  try {
    const result = await sendTemplateEmail({
      resend: {
        emails: {
          send: async (...args) => {
            calls.push(args);
            return { data: { id: "resend-template-email-id" }, error: null };
          },
        },
      },
      config: {
        from: "CodeSniper <noreply@codesniper.in>",
        publicUrl: "https://codesniper.in",
        unsubscribeSecret: process.env.EMAIL_UNSUBSCRIBE_SECRET,
      },
      templateId: "published-template-id",
      variableMap: new Map([
        ["name", "name"],
        ["unsubscribe_url", "unsubscribeUrl"],
      ]),
      user: {
        _id: "507f1f77bcf86cd799439011",
        name: "Asha",
        email: "asha@example.com",
      },
      scheduledDate: "2026-10-09",
      idempotencyKey: "daily-challenge-once",
    });

    assert.equal(result.id, "resend-template-email-id");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0].template, {
      id: "published-template-id",
      variables: {
        name: "Asha",
        unsubscribe_url: calls[0][0].headers["List-Unsubscribe"].slice(1, -1),
      },
    });
    assert.equal(calls[0][1].idempotencyKey, "daily-challenge-once");
    assert.deepEqual(calls[0][0].tags, [
      { name: "email_type", value: "daily_challenge" },
      { name: "user_id", value: "507f1f77bcf86cd799439011" },
      { name: "scheduled_date", value: "2026-10-09" },
    ]);
    const unsubscribeUrl = new URL(
      calls[0][0].headers["List-Unsubscribe"].slice(1, -1),
    );
    assert.equal(unsubscribeUrl.pathname, "/api/email/unsubscribe");
    assert.equal(
      verifyUnsubscribeToken(unsubscribeUrl.searchParams.get("token")),
      "507f1f77bcf86cd799439011",
    );
    assert.equal(calls[0][0].html, undefined);
    assert.equal(calls[0][0].text, undefined);
  } finally {
    if (savedSecret === undefined) {
      delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
    } else {
      process.env.EMAIL_UNSUBSCRIBE_SECRET = savedSecret;
    }
  }
});

test("updates matching tracking records when Resend confirms delivery", async () => {
  let updateArguments;
  const result = await applyResendWebhookEvent(
    {
      type: "email.delivered",
      created_at: "2026-10-09T01:31:00.000Z",
      data: {
        email_id: "resend-accepted-id",
        tags: {
          email_type: "daily_challenge",
          user_id: "507f1f77bcf86cd799439011",
          scheduled_date: "2026-10-09",
        },
      },
    },
    {
      updateOne: async (...args) => {
        updateArguments = args;
        return { matchedCount: 1 };
      },
    },
  );

  assert.deepEqual(result, { ignored: false });
  assert.deepEqual(updateArguments[0], {
    userId: "507f1f77bcf86cd799439011",
    emailType: "daily_challenge",
    scheduledDate: "2026-10-09",
    status: { $in: ["sending", "accepted", "uncertain"] },
  });
  assert.equal(updateArguments[1].$set.status, "delivered");
  assert.equal(updateArguments[1].$set.resendEmailId, "resend-accepted-id");
});

test("skips non-consenting, blocked, duplicate, and invalid recipients", async () => {
  const reserved = [];
  const skippedRecords = [];
  const result = await processDailyChallengeUsers({
    scheduledDate: "2026-10-09",
    users: [
      { _id: "opted-out", email: "off@example.com", dailyChallengeEmailOptIn: false },
      { _id: "blocked", email: "blocked@example.com", dailyChallengeEmailOptIn: true, blocked: true },
      { _id: "invalid", email: "not-an-email", dailyChallengeEmailOptIn: true },
      { _id: "duplicate", email: "dup@example.com", dailyChallengeEmailOptIn: true },
      { _id: "sent", email: "ok@example.com", dailyChallengeEmailOptIn: true },
    ],
    reserve: async (user) => {
      reserved.push(user._id);
      return user._id === "duplicate" ? null : { _id: user._id };
    },
    recordSkipped: async (user) => skippedRecords.push(user._id),
    send: async () => ({ id: "resend-id" }),
    update: async () => {},
    logger: silentLogger,
  });

  assert.deepEqual(reserved, ["duplicate", "sent"]);
  assert.deepEqual(skippedRecords, ["invalid"]);
  assert.deepEqual(result, {
    attempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 4,
  });
});

test("continues after a recipient failure and tracks acceptance separately", async () => {
  const statuses = [];
  const result = await processDailyChallengeUsers({
    scheduledDate: "2026-10-09",
    users: [
      { _id: "failure", email: "fail@example.com", dailyChallengeEmailOptIn: true },
      { _id: "success", email: "ok@example.com", dailyChallengeEmailOptIn: true },
    ],
    reserve: async (user) => ({ _id: user._id }),
    send: async (user) => {
      if (user._id === "failure") {
        const error = new Error("Resend rejected this request.");
        error.deliveryCertain = true;
        throw error;
      }
      return { id: "resend-accepted-id" };
    },
    update: async (tracking, update) => statuses.push([tracking._id, update.status]),
    logger: silentLogger,
  });

  assert.deepEqual(statuses, [
    ["failure", "failed"],
    ["success", "accepted"],
  ]);
  assert.deepEqual(result, {
    attempted: 2,
    succeeded: 1,
    failed: 1,
    skipped: 0,
  });
});

test("validates recipient addresses", () => {
  assert.equal(isValidEmail("person@example.com"), true);
  assert.equal(isValidEmail("person@"), false);
  assert.equal(isValidEmail("not an email"), false);
});

test("defaults existing users to opted out and enforces unique daily tracking", () => {
  assert.equal(User.schema.path("dailyChallengeEmailOptIn").defaultValue, false);
  assert.ok(
    DailyEmailTracking.schema
      .indexes()
      .some(
        ([keys, options]) =>
          keys.userId === 1 &&
          keys.emailType === 1 &&
          keys.scheduledDate === 1 &&
          options.unique === true,
      ),
  );
});

test("reports missing environment configuration clearly without connecting to MongoDB", async () => {
  const names = [
    "RESEND_API_KEY",
    "RESEND_TEMPLATE_ID",
    "EMAIL_FROM",
    "DAILY_EMAIL_PUBLIC_URL",
    "EMAIL_UNSUBSCRIBE_SECRET",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));

  for (const name of names) {
    delete process.env[name];
  }
  try {
    await assert.rejects(
      runDailyChallengeJob({ dryRun: true }),
      /RESEND_API_KEY, RESEND_TEMPLATE_ID, EMAIL_FROM, DAILY_EMAIL_PUBLIC_URL, EMAIL_UNSUBSCRIBE_SECRET/,
    );
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
