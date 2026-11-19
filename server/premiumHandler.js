/* eslint-env node */
import crypto from "node:crypto";
import {
  AuthSession,
  Entitlement,
  Payment,
  PremiumPlan,
  User,
  WebhookEvent,
} from "./db.js";
import {
  createAuthSession,
  getRequestIdentity,
  isEntitlementCurrent,
} from "./premiumAccess.js";

const MODULES = ["DSA", "PRACTICE"];
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 20;
const rateBuckets = new Map();
const orderCreationLocks = new Set();
const DEFAULT_PLANS = [
  {
    code: "DSA",
    name: "DSA Premium",
    amount: 59900,
    currency: "INR",
    modules: ["DSA"],
    features: [
      "Advanced DSA problem access",
      "Premium DSA learning content",
      "Detailed problem explanations",
      "Advanced DSA practice resources",
    ],
  },
  {
    code: "PRACTICE",
    name: "Practice Premium",
    amount: 49900,
    currency: "INR",
    modules: ["PRACTICE"],
    features: [
      "Advanced coding practice",
      "Topic-wise coding questions",
      "Advanced test cases",
      "Practice resources",
    ],
  },
  {
    code: "COMPLETE",
    name: "Complete Premium",
    amount: 99900,
    currency: "INR",
    modules: MODULES,
    features: [
      "All DSA Premium features",
      "All Practice Premium features",
      "Complete access to both premium modules",
    ],
  },
];

export const seedPremiumPlans = async () =>
  Promise.all(
    DEFAULT_PLANS.map((plan) =>
      PremiumPlan.findOneAndUpdate(
        { code: plan.code },
        { $setOnInsert: plan },
        { upsert: true, new: true, runValidators: true },
      ).lean(),
    ),
  );

export const calculatePremiumAmount = ({
  plan,
  existingModules = [],
  modulePrices = {},
}) => {
  const missingModules = plan.modules.filter(
    (moduleName) => !existingModules.includes(moduleName),
  );

  if (!missingModules.length) {
    return { amount: 0, missingModules };
  }

  if (plan.code !== "COMPLETE") {
    return { amount: plan.amount, missingModules };
  }

  const amount = Math.max(
    0,
    plan.amount -
      existingModules.reduce(
        (sum, moduleName) => sum + (modulePrices[moduleName] || 0),
        0,
      ),
  );

  return { amount, missingModules };
};

export const verifyRazorpaySignature = ({
  orderId,
  paymentId,
  signature,
  secret,
}) => {
  if (!orderId || !paymentId || !signature || !secret) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest();
  let actual;

  try {
    actual = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
};

export const verifyRazorpayWebhookSignature = ({
  payload,
  signature,
  secret,
}) => {
  if (!payload || !signature || !secret) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
};

const safeEqualText = (first, second) => {
  const firstHash = crypto.createHash("sha256").update(first).digest();
  const secondHash = crypto.createHash("sha256").update(second).digest();
  return crypto.timingSafeEqual(firstHash, secondHash) && first === second;
};

const isRateLimited = (request, scope) => {
  const key = `${scope}:${request.socket?.remoteAddress || "unknown"}`;
  const now = Date.now();
  for (const [bucketKey, bucketValue] of rateBuckets) {
    if (now >= bucketValue.startedAt + RATE_WINDOW_MS) {
      rateBuckets.delete(bucketKey);
    }
  }
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.startedAt + RATE_WINDOW_MS) {
    rateBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
};

const sendLimited = (request, response, sendJson, scope) => {
  if (!isRateLimited(request, scope)) {
    return false;
  }

  sendJson(response, 429, {
    code: "RATE_LIMITED",
    message: "Too many payment requests. Please wait and try again.",
  });
  return true;
};

const readJson = async (request) => {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw new Error("Request body exceeds the 64 KB limit.");
    }
  }
  return raw ? JSON.parse(raw) : {};
};

const readText = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Webhook payload exceeds the 1 MB limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const getUserIdentity = async (request, response, sendJson) => {
  const identity = await getRequestIdentity(request);

  if (!identity || identity.role !== "user") {
    sendJson(response, 401, {
      code: "AUTHENTICATION_REQUIRED",
      message: "Please sign in again to continue.",
    });
    return null;
  }

  return identity;
};

const getAdminIdentity = async (request, response, sendJson) => {
  const identity = await getRequestIdentity(request);

  if (!identity || identity.role !== "admin") {
    sendJson(response, 403, {
      code: "ADMIN_REQUIRED",
      message: "Administrator access is required.",
    });
    return null;
  }

  return identity;
};

const getRazorpayConfig = () => {
  const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!keyId || !keySecret) {
    const error = new Error("Razorpay is not configured on this server.");
    error.statusCode = 503;
    error.code = "RAZORPAY_NOT_CONFIGURED";
    throw error;
  }
  return { keyId, keySecret };
};

const razorpayRequest = async (endpoint, { method = "GET", body } = {}) => {
  const { keyId, keySecret } = getRazorpayConfig();
  let response;
  try {
    response = await fetch(`https://api.razorpay.com/v1${endpoint}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    const error = new Error(
      cause?.name === "TimeoutError"
        ? "Razorpay request timed out. Please try again."
        : "Unable to connect to Razorpay. Please try again.",
    );
    error.statusCode = cause?.name === "TimeoutError" ? 504 : 502;
    error.code = "RAZORPAY_CONNECTION_FAILED";
    throw error;
  }
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.error?.description || "Razorpay could not process the request.",
    );
    error.statusCode = 502;
    error.code = "RAZORPAY_REQUEST_FAILED";
    throw error;
  }

  return payload;
};

const getActiveEntitlements = async (userId) => {
  const rows = await Entitlement.find({
    userId,
    status: "active",
  })
    .sort({ createdAt: 1 })
    .lean();
  return rows.filter((row) => isEntitlementCurrent(row));
};

const planResponse = (plan) => ({
  code: plan.code,
  name: plan.name,
  amount: plan.amount,
  currency: plan.currency,
  modules: plan.modules,
  features: plan.features,
  active: plan.active,
});

const paymentResponse = (payment) => ({
  id: payment._id.toString(),
  planCode: payment.planCode,
  modules: payment.modulesToGrant,
  amount: payment.amount,
  currency: payment.currency,
  provider: payment.provider,
  orderId: payment.orderId,
  paymentId: payment.paymentId || "",
  status: payment.status,
  paidAt: payment.paidAt,
  refundedAt: payment.refundedAt,
  failureReason: payment.failureReason,
  createdAt: payment.createdAt,
});

const splitPurchaseAmount = (amount, modules, modulePrices) => {
  const totalPrice = modules.reduce(
    (sum, moduleName) => sum + (modulePrices[moduleName] || 0),
    0,
  );
  let allocated = 0;

  return modules.map((moduleName, index) => {
    const share =
      index === modules.length - 1
        ? amount - allocated
        : Math.round((amount * (modulePrices[moduleName] || 0)) / totalPrice);
    allocated += share;
    return { module: moduleName, amount: share };
  });
};

const activatePayment = async ({ payment, paymentId, paidAt }) => {
  const session = await Payment.startSession();
  try {
    await session.withTransaction(async () => {
      const currentPayment = await Payment.findById(payment._id).session(session);
      if (!currentPayment || currentPayment.status === "refunded") {
        return;
      }

      currentPayment.status = "captured";
      currentPayment.paymentId = paymentId;
      currentPayment.paidAt = paidAt || new Date();
      currentPayment.failureReason = "";
      await currentPayment.save({ session });

      const modulePlans = await PremiumPlan.find({
        code: { $in: ["DSA", "PRACTICE"] },
      })
        .select("code amount")
        .session(session)
        .lean();
      const modulePrices = Object.fromEntries(
        modulePlans.map((plan) => [plan.code, plan.amount]),
      );
      const shares = splitPurchaseAmount(
        currentPayment.amount,
        currentPayment.modulesToGrant,
        modulePrices,
      );

      for (const { module, amount } of shares) {
        const entitlement = await Entitlement.findOne({
          userId: currentPayment.userId,
          module,
        }).session(session);
        const fields = {
          purchaseId: currentPayment.orderId,
          paymentId,
          purchaseAmount: amount,
          purchaseDate: currentPayment.paidAt,
          expiresAt: null,
          provider: currentPayment.provider,
          status: "active",
        };

        if (entitlement) {
          if (
            entitlement.status !== "active" ||
            (entitlement.expiresAt && entitlement.expiresAt <= new Date())
          ) {
            Object.assign(entitlement, fields);
            await entitlement.save({ session });
          }
        } else {
          await Entitlement.create(
            [
              {
                userId: currentPayment.userId,
                module,
                ...fields,
              },
            ],
            { session },
          );
        }
      }
    });
  } finally {
    await session.endSession();
  }
};

const deactivateRefundedEntitlements = async (payment) => {
  const remainingPayments = await Payment.find({
    userId: payment.userId,
    _id: { $ne: payment._id },
    status: "captured",
    modulesToGrant: { $in: payment.modulesToGrant },
  })
    .select("modulesToGrant")
    .lean();
  const stillOwned = new Set(remainingPayments.flatMap((row) => row.modulesToGrant));

  await Promise.all(
    payment.modulesToGrant.map((module) =>
      Entitlement.updateOne(
        { userId: payment.userId, module },
        {
          $set: {
            status: stillOwned.has(module) ? "active" : "refunded",
            expiresAt: stillOwned.has(module) ? null : new Date(),
          },
        },
      ),
    ),
  );
};

const handleAdminLogin = async (request, response, sendJson) => {
  if (sendLimited(request, response, sendJson, "admin-login")) {
    return true;
  }
  const username = (process.env.PREMIUM_ADMIN_USERNAME || "").trim();
  const password = process.env.PREMIUM_ADMIN_PASSWORD || "";

  if (!username || !password) {
    sendJson(response, 503, {
      code: "ADMIN_NOT_CONFIGURED",
      message:
        "Premium administrator access is not configured. Set PREMIUM_ADMIN_USERNAME and PREMIUM_ADMIN_PASSWORD in CodingBackend/.env, then restart the backend.",
    });
    return true;
  }

  const body = await readJson(request);
  const providedUsername =
    typeof body.username === "string" ? body.username.trim() : "";
  const providedPassword =
    typeof body.password === "string" ? body.password : "";

  if (
    !safeEqualText(providedUsername, username) ||
    !safeEqualText(providedPassword, password)
  ) {
    sendJson(response, 401, { message: "Administrator credentials are incorrect." });
    return true;
  }

  const session = await createAuthSession({
    role: "admin",
    adminUsername: username,
  });
  sendJson(response, 200, {
    accessToken: session.token,
    expiresAt: session.expiresAt,
  });
  return true;
};

const handleCreateOrder = async (request, response, sendJson) => {
  if (sendLimited(request, response, sendJson, "create-order")) {
    return true;
  }
  const identity = await getUserIdentity(request, response, sendJson);
  if (!identity) return true;

  const userKey = identity.userId.toString();
  if (orderCreationLocks.has(userKey)) {
    sendJson(response, 409, {
      code: "PAYMENT_PENDING",
      message: "A payment order is already being created for this account.",
    });
    return true;
  }
  orderCreationLocks.add(userKey);
  try {
  const body = await readJson(request);
  const code = String(body.planCode || "").trim().toUpperCase();
  if (!["DSA", "PRACTICE", "COMPLETE"].includes(code)) {
    sendJson(response, 400, { message: "Select a valid premium plan." });
    return true;
  }

  const plans = await seedPremiumPlans();
  const plan = plans.find((item) => item.code === code);
  if (!plan?.active) {
    sendJson(response, 404, { message: "This premium plan is unavailable." });
    return true;
  }

  const active = await getActiveEntitlements(identity.userId);
  const existingModules = active.map((row) => row.module);
  const modulePrices = Object.fromEntries(
    plans
      .filter((item) => ["DSA", "PRACTICE"].includes(item.code))
      .map((item) => [item.code, item.amount]),
  );
  const { amount, missingModules } = calculatePremiumAmount({
    plan,
    existingModules,
    modulePrices,
  });
  if (!missingModules.length) {
    sendJson(response, 409, {
      code: "ALREADY_OWNED",
      message: "You already have access to every module in this plan.",
    });
    return true;
  }
  if (amount < 1) {
    sendJson(response, 503, {
      code: "INVALID_PLAN_CONFIGURATION",
      message: "This plan price is not configured correctly. Please contact support.",
    });
    return true;
  }

  const pending = await Payment.findOne({
    userId: identity.userId,
    status: { $in: ["created", "authorized"] },
    modulesToGrant: { $in: missingModules },
  }).lean();
  if (pending) {
    sendJson(response, 409, {
      code: "PAYMENT_PENDING",
      message: "Finish or cancel your existing payment before starting another.",
    });
    return true;
  }

  const { keyId } = getRazorpayConfig();
  const receipt = `cs_${crypto.randomUUID().replace(/-/g, "")}`;
  const order = await razorpayRequest("/orders", {
    method: "POST",
    body: {
      amount,
      currency: plan.currency,
      receipt,
      notes: {
        userId: identity.userId.toString(),
        planCode: code,
        modules: missingModules.join(","),
      },
    },
  });
  await Payment.create({
    userId: identity.userId,
    planCode: code,
    modulesToGrant: missingModules,
    amount,
    currency: plan.currency,
    orderId: order.id,
    receipt,
    status: "created",
  });

  sendJson(response, 201, {
    keyId,
    orderId: order.id,
    amount,
    currency: plan.currency,
    plan: planResponse(plan),
    modulesToGrant: missingModules,
  });
  return true;
  } finally {
    orderCreationLocks.delete(userKey);
  }
};

const handleVerifyPayment = async (request, response, sendJson) => {
  if (sendLimited(request, response, sendJson, "verify-payment")) {
    return true;
  }
  const identity = await getUserIdentity(request, response, sendJson);
  if (!identity) return true;
  const body = await readJson(request);
  const orderId = String(body.razorpay_order_id || "");
  const paymentId = String(body.razorpay_payment_id || "");
  const signature = String(body.razorpay_signature || "");
  const payment = await Payment.findOne({
    userId: identity.userId,
    orderId,
  });

  if (!payment || !verifyRazorpaySignature({
    orderId,
    paymentId,
    signature,
    secret: (process.env.RAZORPAY_KEY_SECRET || "").trim(),
  })) {
    sendJson(response, 400, {
      code: "INVALID_PAYMENT_SIGNATURE",
      message: "Payment verification failed. No premium access was granted.",
    });
    return true;
  }

  if (["refund_pending", "refunded"].includes(payment.status)) {
    sendJson(response, 409, {
      code: "PAYMENT_NOT_ACTIVE",
      message: "This payment is no longer eligible for access activation.",
    });
    return true;
  }

  if (payment.status === "captured") {
    sendJson(response, 200, {
      message: "Payment already verified.",
      access: (await getActiveEntitlements(identity.userId)).map((row) => row.module),
    });
    return true;
  }

  const paymentDetails = await razorpayRequest(
    `/payments/${encodeURIComponent(paymentId)}`,
  );
  if (
    paymentDetails.order_id !== orderId ||
    paymentDetails.amount !== payment.amount ||
    paymentDetails.currency !== payment.currency
  ) {
    sendJson(response, 400, {
      code: "PAYMENT_DETAILS_MISMATCH",
      message: "Payment details did not match the created order.",
    });
    return true;
  }

  if (paymentDetails.status === "failed") {
    payment.status = "failed";
    payment.failureReason = paymentDetails.error_description || "Payment failed.";
    await payment.save();
    sendJson(response, 402, {
      code: "PAYMENT_FAILED",
      message: "Payment was not captured. Please try again.",
    });
    return true;
  }

  if (paymentDetails.status !== "captured") {
    payment.status = "authorized";
    payment.paymentId = paymentId;
    await payment.save();
    sendJson(response, 202, {
      code: "PAYMENT_PENDING",
      message: "Payment is awaiting capture confirmation.",
    });
    return true;
  }

  await activatePayment({
    payment,
    paymentId,
    paidAt: paymentDetails.created_at
      ? new Date(paymentDetails.created_at * 1000)
      : new Date(),
  });
  sendJson(response, 200, {
    message: "Payment verified and premium access activated.",
    access: (await getActiveEntitlements(identity.userId)).map((row) => row.module),
  });
  return true;
};

const handleCancelOrder = async (request, response, sendJson) => {
  const identity = await getUserIdentity(request, response, sendJson);
  if (!identity) return true;
  const body = await readJson(request);
  const orderId = String(body.orderId || "");
  const payment = await Payment.findOneAndUpdate(
    {
      userId: identity.userId,
      orderId,
      status: { $in: ["created", "authorized"] },
    },
    { $set: { status: "cancelled" } },
    { new: true },
  );
  sendJson(response, 200, {
    message: payment ? "Checkout cancelled." : "No pending order was found.",
  });
  return true;
};

const handleMyAccess = async (request, response, sendJson) => {
  const identity = await getUserIdentity(request, response, sendJson);
  if (!identity) return true;
  const [entitlements, payments] = await Promise.all([
    getActiveEntitlements(identity.userId),
    Payment.find({ userId: identity.userId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  sendJson(response, 200, {
    modules: MODULES.map((module) => {
      const entitlement = entitlements.find((row) => row.module === module);
      return {
        module,
        active: Boolean(entitlement),
        purchaseDate: entitlement?.purchaseDate || null,
        expiresAt: entitlement?.expiresAt || null,
      };
    }),
    payments: payments.map(paymentResponse),
  });
  return true;
};

const handlePlans = async (response, sendJson) => {
  const plans = await seedPremiumPlans();
  sendJson(response, 200, {
    items: plans.filter((plan) => plan.active).map(planResponse),
  });
  return true;
};

const handleAdminOverview = async (request, response, sendJson, url) => {
  if (!await getAdminIdentity(request, response, sendJson)) return true;
  const search = (url.searchParams.get("search") || "").trim();
  const userQuery = search
    ? {
        $or: [
          { email: { $regex: search, $options: "i" } },
          { name: { $regex: search, $options: "i" } },
        ],
      }
    : {};
  const users = await User.find(userQuery)
    .select("_id name email")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const userIds = users.map((user) => user._id);
  const [entitlements, payments, revenueRows, plans] = await Promise.all([
    Entitlement.find({ userId: { $in: userIds } }).lean(),
    Payment.find({ userId: { $in: userIds } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    Payment.aggregate([
      { $match: { status: { $in: ["captured", "refunded"] } } },
      {
        $group: {
          _id: "$status",
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]),
    seedPremiumPlans(),
  ]);
  const entitlementByUser = new Map();
  for (const entitlement of entitlements) {
    if (!entitlementByUser.has(entitlement.userId.toString())) {
      entitlementByUser.set(entitlement.userId.toString(), []);
    }
    entitlementByUser.get(entitlement.userId.toString()).push(entitlement);
  }
  const captured = revenueRows.find((row) => row._id === "captured");
  const refunded = revenueRows.find((row) => row._id === "refunded");

  sendJson(response, 200, {
    summary: {
      dsaSubscribers: entitlements.filter(
        (row) => row.module === "DSA" && row.status === "active",
      ).length,
      practiceSubscribers: entitlements.filter(
        (row) => row.module === "PRACTICE" && row.status === "active",
      ).length,
      completeSubscribers: users.filter((user) => {
        const modules = new Set(
          (entitlementByUser.get(user._id.toString()) || [])
            .filter((row) => row.status === "active")
            .map((row) => row.module),
        );
        return modules.has("DSA") && modules.has("PRACTICE");
      }).length,
      successfulPayments: captured?.count || 0,
      failedPayments: payments.filter((row) => row.status === "failed").length,
      refundedPayments: refunded?.count || 0,
      revenue: (captured?.amount || 0) - (refunded?.amount || 0),
    },
    users: users.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      entitlements: (entitlementByUser.get(user._id.toString()) || []).map(
        (row) => ({
          module: row.module,
          status: row.status,
          purchaseDate: row.purchaseDate,
          expiresAt: row.expiresAt,
        }),
      ),
    })),
    payments: payments.map((payment) => ({
      ...paymentResponse(payment),
      userId: payment.userId.toString(),
      user: users.find(
        (user) => user._id.toString() === payment.userId.toString(),
      )?.email || "",
    })),
    plans: plans.map(planResponse),
  });
  return true;
};

const handlePlanUpdate = async (request, response, sendJson, planCode) => {
  if (!await getAdminIdentity(request, response, sendJson)) return true;
  const code = decodeURIComponent(planCode).toUpperCase();
  const body = await readJson(request);
  const updates = {};

  if ("amount" in body) {
    const amount = Number(body.amount);
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) {
      sendJson(response, 400, {
        message: "Plan amount must be a whole number of paise within the allowed range.",
      });
      return true;
    }
    updates.amount = amount;
  }

  if ("features" in body) {
    if (
      !Array.isArray(body.features) ||
      body.features.length > 20 ||
      body.features.some(
        (feature) => typeof feature !== "string" || !feature.trim() || feature.length > 200,
      )
    ) {
      sendJson(response, 400, { message: "Plan features must be a list of short text values." });
      return true;
    }
    updates.features = body.features.map((feature) => feature.trim());
  }

  if ("active" in body) {
    if (typeof body.active !== "boolean") {
      sendJson(response, 400, { message: "Plan active must be a boolean." });
      return true;
    }
    updates.active = body.active;
  }

  if (!Object.keys(updates).length) {
    sendJson(response, 400, { message: "Provide an amount, feature list, or active status." });
    return true;
  }

  const plan = await PremiumPlan.findOneAndUpdate(
    { code },
    { $set: updates },
    { new: true, runValidators: true },
  );
  if (!plan) {
    sendJson(response, 404, { message: "Premium plan not found." });
    return true;
  }
  sendJson(response, 200, { plan: planResponse(plan) });
  return true;
};

const handleRefund = async (request, response, sendJson, paymentId) => {
  if (!await getAdminIdentity(request, response, sendJson)) return true;
  const payment = await Payment.findOne({
    paymentId: decodeURIComponent(paymentId),
    status: "captured",
  });
  if (!payment) {
    sendJson(response, 404, { message: "Captured payment not found." });
    return true;
  }

  await razorpayRequest(
    `/payments/${encodeURIComponent(payment.paymentId)}/refund`,
    { method: "POST", body: {} },
  );
  payment.status = "refund_pending";
  await payment.save();
  sendJson(response, 202, {
    message: "Refund requested. Access will update when Razorpay confirms it.",
    payment: paymentResponse(payment),
  });
  return true;
};

const processWebhook = async (event, eventId) => {
  const eventRecord = await WebhookEvent.findOneAndUpdate(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        eventType: event.event,
        processed: false,
      },
    },
    { upsert: true, new: true },
  );
  if (eventRecord.processed) {
    return;
  }

  const paymentEntity =
    event.payload?.payment?.entity ||
    event.payload?.refund?.entity?.payment_id;
  const orderId = paymentEntity?.order_id || "";
  const paymentId = paymentEntity?.id || paymentEntity || "";

  if (["payment.captured", "order.paid"].includes(event.event)) {
    const payment = await Payment.findOne({
      $or: [{ orderId }, { paymentId }],
    });
    if (
      payment &&
      paymentEntity?.amount === payment.amount &&
      paymentEntity?.currency === payment.currency
    ) {
      await activatePayment({
        payment,
        paymentId,
        paidAt: paymentEntity.created_at
          ? new Date(paymentEntity.created_at * 1000)
          : new Date(),
      });
    }
  } else if (event.event === "payment.failed") {
    if (orderId) {
      await Payment.updateOne(
        { orderId, status: { $in: ["created", "authorized"] } },
        {
          $set: {
            status: "failed",
            paymentId,
            failureReason:
              paymentEntity.error_description || "Payment failed.",
          },
        },
      );
    }
  } else if (["refund.processed", "payment.refunded"].includes(event.event)) {
    const relatedPaymentId =
      event.payload?.refund?.entity?.payment_id || paymentId;
    const payment = await Payment.findOneAndUpdate(
      { paymentId: relatedPaymentId },
      { $set: { status: "refunded", refundedAt: new Date() } },
      { new: true },
    );
    if (payment) {
      await deactivateRefundedEntitlements(payment);
    }
  }

  eventRecord.processed = true;
  eventRecord.processedAt = new Date();
  eventRecord.error = "";
  await eventRecord.save();
};

const handleWebhook = async (request, response, sendJson) => {
  const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    sendJson(response, 503, {
      message: "Razorpay webhooks are not configured on this server.",
    });
    return true;
  }

  const rawBody = await readText(request);
  const signature = String(request.headers["x-razorpay-signature"] || "");
  if (
    !verifyRazorpayWebhookSignature({
      payload: rawBody,
      signature,
      secret: webhookSecret,
    })
  ) {
    sendJson(response, 400, { message: "Invalid Razorpay webhook signature." });
    return true;
  }

  const eventId = String(request.headers["x-razorpay-event-id"] || "").trim();
  if (!eventId) {
    sendJson(response, 400, { message: "Razorpay event ID is required." });
    return true;
  }

  const event = JSON.parse(rawBody);
  await processWebhook(event, eventId);
  sendJson(response, 200, { received: true });
  return true;
};

export const handlePremiumRequest = async (
  request,
  response,
  pathname,
  url,
  sendJson,
) => {
  const isAdminAuthRoute = [
    "/api/admin/login",
    "/api/admin/logout",
  ].includes(pathname);
  if (!pathname.startsWith("/api/premium/") && !isAdminAuthRoute) {
    return false;
  }

  if (request.method === "GET" && pathname === "/api/premium/plans") {
    return handlePlans(response, sendJson);
  }
  if (
    request.method === "POST" &&
    ["/api/admin/login", "/api/premium/admin/login"].includes(pathname)
  ) {
    return handleAdminLogin(request, response, sendJson);
  }
  if (
    request.method === "POST" &&
    ["/api/admin/logout", "/api/premium/admin/logout"].includes(pathname)
  ) {
    const identity = await getAdminIdentity(request, response, sendJson);
    if (!identity) return true;
    await AuthSession.deleteOne({ _id: identity.sessionId });
    sendJson(response, 200, { message: "Administrator signed out." });
    return true;
  }
  if (
    request.method === "POST" &&
    pathname === "/api/premium/webhook"
  ) {
    return handleWebhook(request, response, sendJson);
  }
  if (
    request.method === "POST" &&
    pathname === "/api/premium/create-order"
  ) {
    return handleCreateOrder(request, response, sendJson);
  }
  if (
    request.method === "POST" &&
    pathname === "/api/premium/verify-payment"
  ) {
    return handleVerifyPayment(request, response, sendJson);
  }
  if (
    request.method === "POST" &&
    pathname === "/api/premium/cancel-order"
  ) {
    return handleCancelOrder(request, response, sendJson);
  }
  if (
    request.method === "GET" &&
    pathname === "/api/premium/my-access"
  ) {
    return handleMyAccess(request, response, sendJson);
  }
  if (
    request.method === "GET" &&
    pathname === "/api/premium/admin/overview"
  ) {
    return handleAdminOverview(request, response, sendJson, url);
  }

  const planMatch = pathname.match(/^\/api\/premium\/admin\/plans\/([^/]+)$/);
  if (request.method === "PATCH" && planMatch) {
    return handlePlanUpdate(request, response, sendJson, planMatch[1]);
  }

  const refundMatch = pathname.match(
    /^\/api\/premium\/admin\/payments\/([^/]+)\/refund$/,
  );
  if (request.method === "POST" && refundMatch) {
    return handleRefund(request, response, sendJson, refundMatch[1]);
  }

  sendJson(response, 404, { message: "Premium API route not found." });
  return true;
};

export const revokeAuthSession = async (request) => {
  const identity = await getRequestIdentity(request);
  if (identity?.sessionId) {
    await AuthSession.deleteOne({ _id: identity.sessionId });
  }
  return Boolean(identity);
};

export const supportedPremiumModules = MODULES;
