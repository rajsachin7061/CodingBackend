/* eslint-env node */
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Resend } from "resend";
import {
  DailyEmailJobLock,
  DailyEmailTracking,
  User,
} from "./db.js";

export const DAILY_EMAIL_TYPE = "daily_challenge";
export const DAILY_EMAIL_TIME_ZONE = "Asia/Kolkata";
const LOCK_LEASE_MS = 30 * 60 * 1000;
const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DAILY_EMAIL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const resendClients = new Map();

export const isValidEmail = (email) =>
  typeof email === "string" &&
  email.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

export const getScheduledDate = (date = new Date()) =>
  IST_DATE_FORMATTER.format(date);

export const getNextDailyRunAt = (now = new Date()) => {
  const scheduledDate = getScheduledDate(now);
  const [year, month, day] = scheduledDate.split("-").map(Number);
  const todayRun = new Date(Date.UTC(year, month - 1, day, 1, 30));
  let nextRun = todayRun;

  if (nextRun <= now) {
    nextRun = new Date(nextRun.getTime() + 24 * 60 * 60 * 1000);
  }

  return nextRun;
};

const getUnsubscribeSecret = () => {
  const secret = process.env.EMAIL_UNSUBSCRIBE_SECRET?.trim() || "";
  if (secret.length < 32) {
    throw new Error("EMAIL_UNSUBSCRIBE_SECRET must be set to at least 32 characters.");
  }
  return secret;
};

const getRequiredConfig = () => {
  const required = [
    ["RESEND_API_KEY", process.env.RESEND_API_KEY],
    ["RESEND_TEMPLATE_ID", process.env.RESEND_TEMPLATE_ID],
    ["EMAIL_FROM", process.env.EMAIL_FROM],
    ["DAILY_EMAIL_PUBLIC_URL", process.env.DAILY_EMAIL_PUBLIC_URL],
    ["EMAIL_UNSUBSCRIBE_SECRET", process.env.EMAIL_UNSUBSCRIBE_SECRET],
  ];
  const missing = required
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(
      `Daily challenge email configuration is missing: ${missing.join(", ")}.`,
    );
  }

  const publicUrl = process.env.DAILY_EMAIL_PUBLIC_URL.trim().replace(/\/+$/, "");
  let parsedPublicUrl;
  try {
    parsedPublicUrl = new URL(publicUrl);
  } catch {
    throw new Error("DAILY_EMAIL_PUBLIC_URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsedPublicUrl.protocol)) {
    throw new Error("DAILY_EMAIL_PUBLIC_URL must use HTTP or HTTPS.");
  }

  return {
    apiKey: process.env.RESEND_API_KEY.trim(),
    templateId: process.env.RESEND_TEMPLATE_ID.trim(),
    from: process.env.EMAIL_FROM.trim(),
    publicUrl,
    unsubscribeSecret: getUnsubscribeSecret(),
  };
};

export const validateDailyChallengeEmailConfig = () => getRequiredConfig();

const getResend = (apiKey) => {
  if (!resendClients.has(apiKey)) {
    resendClients.set(apiKey, new Resend(apiKey));
  }

  return resendClients.get(apiKey);
};

const getTemplateAndVariables = async (resend, templateId) => {
  const { data, error } = await resend.templates.get(templateId);

  if (error) {
    throw new Error(`Unable to load the configured Resend template: ${error.message}`);
  }

  if (!data || data.status !== "published") {
    throw new Error("RESEND_TEMPLATE_ID must reference a published Resend template.");
  }

  const declaredVariables = Array.isArray(data.variables) ? data.variables : [];
  let configuredMap = {};
  const rawMap = process.env.RESEND_TEMPLATE_VARIABLE_MAP;
  if (rawMap?.trim()) {
    try {
      configuredMap = JSON.parse(rawMap);
    } catch (error) {
      throw new Error(
        `RESEND_TEMPLATE_VARIABLE_MAP must be valid JSON: ${error.message}`,
      );
    }

    if (
      !configuredMap ||
      Array.isArray(configuredMap) ||
      typeof configuredMap !== "object"
    ) {
      throw new Error("RESEND_TEMPLATE_VARIABLE_MAP must be a JSON object.");
    }
  }

  const declaredKeys = new Set(declaredVariables.map(({ key }) => key));
  const validSources = new Set([
    "name",
    "email",
    "unsubscribeUrl",
    "scheduledDate",
  ]);

  for (const [key, source] of Object.entries(configuredMap)) {
    if (!declaredKeys.has(key)) {
      throw new Error(
        `RESEND_TEMPLATE_VARIABLE_MAP references undeclared template variable "${key}".`,
      );
    }
    if (!validSources.has(source)) {
      throw new Error(
        `Unsupported source "${source}" for Resend template variable "${key}".`,
      );
    }
  }

  const variableMap = new Map(Object.entries(configuredMap));
  for (const { key } of declaredVariables) {
    if (variableMap.has(key)) {
      continue;
    }

    if (/^(name|username|user_name|first_name)$/i.test(key)) {
      variableMap.set(key, "name");
    } else if (/unsubscribe/i.test(key)) {
      variableMap.set(key, "unsubscribeUrl");
    } else if (/^(email|user_email)$/i.test(key)) {
      variableMap.set(key, "email");
    } else if (/^(date|scheduled_date)$/i.test(key)) {
      variableMap.set(key, "scheduledDate");
    }
  }

  const unmappedRequired = declaredVariables
    .filter(
      ({ key, fallback_value: fallbackValue }) =>
        !variableMap.has(key) && fallbackValue == null,
    )
    .map(({ key }) => key);

  if (unmappedRequired.length) {
    throw new Error(
      `The published template has required variables with no fallback or mapping: ${unmappedRequired.join(", ")}. Set RESEND_TEMPLATE_VARIABLE_MAP using supported sources.`,
    );
  }

  return { data, variableMap };
};

export const buildTemplateVariables = ({
  variableMap,
  user,
  unsubscribeUrl,
  scheduledDate,
}) => {
  const values = {
    name: typeof user.name === "string" ? user.name : "",
    email: typeof user.email === "string" ? user.email : "",
    unsubscribeUrl,
    scheduledDate,
  };
  const variables = {};

  for (const [key, source] of variableMap) {
    variables[key] = values[source];
  }

  return variables;
};

const createUnsubscribeUrl = (userId, config) => {
  const signature = crypto
    .createHmac("sha256", config.unsubscribeSecret)
    .update(String(userId))
    .digest("hex");
  const token = `${userId}.${signature}`;
  return `${config.publicUrl}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
};

export const verifyUnsubscribeToken = (token) => {
  const unsubscribeSecret = getUnsubscribeSecret();
  const [userId, signature, extra] = String(token || "").split(".");
  if (!userId || !signature || extra || !/^[a-f\d]{24}$/i.test(userId)) {
    return null;
  }

  const expected = crypto
    .createHmac("sha256", unsubscribeSecret)
    .update(userId)
    .digest();
  let actual;
  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return null;
  }

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }

  return userId;
};

export const processDailyChallengeUsers = async ({
  users,
  scheduledDate,
  dryRun = false,
  reserve,
  recordSkipped,
  send,
  update,
  logger = console,
}) => {
  const counts = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const user of users) {
    if (user.dailyChallengeEmailOptIn !== true || user.blocked === true) {
      counts.skipped += 1;
      continue;
    }

    if (!isValidEmail(user.email)) {
      counts.skipped += 1;
      if (!dryRun && recordSkipped) {
        try {
          await recordSkipped(user, scheduledDate);
        } catch (error) {
          counts.failed += 1;
          logger.error("Invalid recipient could not be recorded as skipped.", {
            error: error.message,
          });
        }
      }
      continue;
    }

    if (dryRun) {
      counts.attempted += 1;
      continue;
    }

    let tracking;
    try {
      tracking = await reserve(user, scheduledDate);
    } catch (error) {
      counts.failed += 1;
      logger.error("Daily challenge email tracking reservation failed.", {
        error: error.message,
      });
      continue;
    }

    if (!tracking) {
      counts.skipped += 1;
      continue;
    }

    counts.attempted += 1;
    try {
      const result = await send(user, scheduledDate);
      try {
        await update(tracking, {
          status: "accepted",
          resendEmailId: result.id || "",
          errorDetails: "",
          completedAt: new Date(),
        });
        counts.succeeded += 1;
      } catch (error) {
        counts.failed += 1;
        logger.error("Resend accepted an email but tracking could not be updated.", {
          error: error.message,
        });
      }
    } catch (error) {
      const status = error.deliveryCertain ? "failed" : "uncertain";
      try {
        await update(tracking, {
          status,
          errorDetails: String(error.message || "Unknown Resend error").slice(0, 2000),
          completedAt: new Date(),
        });
      } catch (trackingError) {
        logger.error("Daily challenge email failure could not be tracked.", {
          error: trackingError.message,
        });
      }
      counts.failed += 1;
      logger.error(`Daily challenge email ${status}.`, {
        error: error.message,
      });
      if (error.stopBatch === true) {
        break;
      }
    }
  }

  logger.info("Daily challenge email batch finished.", counts);
  return counts;
};

const reserveTracking = async (
  user,
  scheduledDate,
  status = "sending",
  errorDetails = "",
) => {
  try {
    return await DailyEmailTracking.create({
      userId: user._id,
      recipientEmail: typeof user.email === "string" ? user.email.trim().toLowerCase() : "",
      emailType: DAILY_EMAIL_TYPE,
      scheduledDate,
      status,
      errorDetails,
      attemptedAt: new Date(),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return null;
    }
    throw error;
  }
};

export const sendTemplateEmail = async ({
  resend,
  config,
  templateId,
  variableMap,
  user,
  scheduledDate,
  idempotencyKey,
}) => {
  const unsubscribeUrl = createUnsubscribeUrl(user._id, config);
  const { data, error } = await resend.emails.send(
    {
      from: config.from,
      to: [user.email.trim().toLowerCase()],
      template: {
        id: templateId,
        variables: buildTemplateVariables({
          variableMap,
          user,
          unsubscribeUrl,
          scheduledDate,
        }),
      },
      tags: [
        { name: "email_type", value: DAILY_EMAIL_TYPE },
        { name: "user_id", value: String(user._id) },
        { name: "scheduled_date", value: scheduledDate },
      ],
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
    { idempotencyKey },
  );

  if (error) {
    const apiError = new Error(`Resend API error: ${error.message}`);
    apiError.deliveryCertain = true;
    throw apiError;
  }

  if (!data?.id) {
    throw new Error("Resend returned no email ID; delivery outcome is uncertain.");
  }

  return { id: data.id };
};

export const verifyResendWebhook = ({ payload, headers }) => {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim() || "";
  const apiKey = process.env.RESEND_API_KEY?.trim() || "";
  if (!webhookSecret) {
    throw new Error("RESEND_WEBHOOK_SECRET is not configured.");
  }
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  return getResend(apiKey).webhooks.verify({
    payload,
    headers: {
      id: headers["svix-id"],
      timestamp: headers["svix-timestamp"],
      signature: headers["svix-signature"],
    },
    webhookSecret,
  });
};

export const applyResendWebhookEvent = async (
  event,
  trackingModel = DailyEmailTracking,
) => {
  const statusByEvent = {
    "email.delivered": "delivered",
    "email.bounced": "failed",
    "email.failed": "failed",
    "email.complained": "failed",
    "email.suppressed": "failed",
  };
  const status = statusByEvent[event?.type];
  const data = event?.data;
  const tags = data?.tags || {};
  if (
    !status ||
    tags.email_type !== DAILY_EMAIL_TYPE ||
    !tags.user_id ||
    !tags.scheduled_date ||
    !data.email_id
  ) {
    return { ignored: true };
  }

  const failureDetails =
    data.bounce?.message ||
    data.failed?.reason ||
    data.suppressed?.message ||
    (status === "failed" ? event.type : "");
  const result = await trackingModel.updateOne(
    {
      userId: tags.user_id,
      emailType: DAILY_EMAIL_TYPE,
      scheduledDate: tags.scheduled_date,
      status: { $in: ["sending", "accepted", "uncertain"] },
    },
    {
      $set: {
        status,
        resendEmailId: data.email_id,
        errorDetails: failureDetails,
        completedAt: new Date(event.created_at || Date.now()),
      },
    },
  );

  return { ignored: result.matchedCount !== 1 };
};

const acquireDailyLock = async (scheduledDate, owner) => {
  const id = `${DAILY_EMAIL_TYPE}:${scheduledDate}`;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LOCK_LEASE_MS);
  const updated = await DailyEmailJobLock.findOneAndUpdate(
    { _id: id, leaseUntil: { $lte: now } },
    { $set: { owner, leaseUntil, status: "running" } },
    { new: true },
  );

  if (updated) {
    return { id, owner };
  }

  try {
    await DailyEmailJobLock.create({ _id: id, owner, leaseUntil, status: "running" });
    return { id, owner };
  } catch (error) {
    if (error?.code === 11000) {
      return null;
    }
    throw error;
  }
};

const renewDailyLock = async (lock) => {
  const result = await DailyEmailJobLock.updateOne(
    { _id: lock.id, owner: lock.owner, status: "running" },
    { $set: { leaseUntil: new Date(Date.now() + LOCK_LEASE_MS) } },
  );
  return result.matchedCount === 1;
};

export const runDailyChallengeJob = async ({
  dryRun = false,
  now = new Date(),
  logger = console,
} = {}) => {
  const scheduledDate = getScheduledDate(now);
  const config = getRequiredConfig();
  const resend = getResend(config.apiKey);
  const { data: template, variableMap } = await getTemplateAndVariables(
    resend,
    config.templateId,
  );
  const optedOutCount = await User.countDocuments({
    dailyChallengeEmailOptIn: { $ne: true },
  });
  const blockedOptInCount = await User.countDocuments({
    dailyChallengeEmailOptIn: true,
    blocked: true,
  });
  const users = await User.find({
    dailyChallengeEmailOptIn: true,
    blocked: { $ne: true },
  })
    .select("_id name email dailyChallengeEmailOptIn blocked")
    .lean();
  const lockOwner = crypto.randomUUID();
  let lock = null;

  if (!dryRun) {
    lock = await acquireDailyLock(scheduledDate, lockOwner);
    if (!lock) {
      const counts = {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: users.length + optedOutCount + blockedOptInCount,
      };
      logger.info("Daily challenge email job was already claimed for this date.", counts);
      return counts;
    }

    await DailyEmailTracking.updateMany(
      { emailType: DAILY_EMAIL_TYPE, scheduledDate, status: "sending" },
      {
        $set: {
          status: "uncertain",
          errorDetails: "Previous worker stopped before recording a Resend result.",
          completedAt: new Date(),
        },
      },
    );
  }

  const counts = await processDailyChallengeUsers({
    users,
    scheduledDate,
    dryRun,
    logger,
    reserve: reserveTracking,
    recordSkipped: (user, date) =>
      reserveTracking(user, date, "skipped", "Invalid email address."),
    send: async (user, date) => {
      if (lock && !(await renewDailyLock(lock))) {
        const error = new Error("Daily email job lock was lost; stopping this worker.");
        error.stopBatch = true;
        throw error;
      }
      return sendTemplateEmail({
        resend,
        config,
        templateId: template.id,
        variableMap,
        user,
        scheduledDate: date,
        idempotencyKey: `codesniper-${DAILY_EMAIL_TYPE}-${date}-${user._id}`,
      });
    },
    update: (tracking, updates) =>
      DailyEmailTracking.updateOne(
        { _id: tracking._id, status: "sending" },
        { $set: updates },
      ),
  });
  counts.skipped += optedOutCount + blockedOptInCount;

  if (lock) {
    await DailyEmailJobLock.updateOne(
      { _id: lock.id, owner: lock.owner },
      {
        $set: {
          status: "completed",
          leaseUntil: new Date(now.getTime() + 25 * 60 * 60 * 1000),
        },
      },
    );
  }

  return counts;
};

export const sendDailyChallengeTestEmail = async (recipient) => {
  if (!isValidEmail(recipient)) {
    throw new Error("DAILY_EMAIL_TEST_RECIPIENT must be a valid email address.");
  }

  const config = getRequiredConfig();
  const resend = getResend(config.apiKey);
  const { data: template, variableMap } = await getTemplateAndVariables(
    resend,
    config.templateId,
  );
  const testUser = {
    _id: new mongoose.Types.ObjectId(),
    name: "CodeSniper test recipient",
    email: recipient.trim().toLowerCase(),
  };
  const result = await sendTemplateEmail({
    resend,
    config,
    templateId: template.id,
    variableMap,
    user: testUser,
    scheduledDate: getScheduledDate(),
    idempotencyKey: `codesniper-daily-test-${crypto.randomUUID()}`,
  });

  return result.id;
};

export const startDailyChallengeScheduler = ({
  logger = console,
  enabled = process.env.DAILY_EMAIL_ENABLED === "true",
  dryRun = process.env.DAILY_EMAIL_DRY_RUN !== "false",
} = {}) => {
  if (!enabled) {
    logger.info("Daily challenge email scheduler is disabled (DAILY_EMAIL_ENABLED is not true).");
    return () => {};
  }

  let timer;
  let stopped = false;

  const scheduleRunAt = (nextRun) => {
    if (stopped) {
      return;
    }
    const delay = Math.max(0, nextRun.getTime() - Date.now());
    logger.info(
      `Daily challenge email scheduled for ${nextRun.toISOString()} (${DAILY_EMAIL_TIME_ZONE}).`,
    );
    timer = setTimeout(async () => {
      try {
        await runDailyChallengeJob({ dryRun, logger });
      } catch (error) {
        logger.error("Daily challenge email job failed.", { error: error.message });
      } finally {
        scheduleRunAt(getNextDailyRunAt());
      }
    }, delay);
    timer.unref?.();
  };

  const now = new Date();
  const [year, month, day] = getScheduledDate(now).split("-").map(Number);
  const todayScheduledRun = new Date(Date.UTC(year, month - 1, day, 1, 30));
  scheduleRunAt(
    now >= todayScheduledRun ? todayScheduledRun : getNextDailyRunAt(now),
  );
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
};
