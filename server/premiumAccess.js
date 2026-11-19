/* eslint-env node */
import crypto from "node:crypto";
import {
  AuthSession,
  Entitlement,
  User,
} from "./db.js";

const configuredSessionDays = Number.parseInt(
  process.env.AUTH_SESSION_TTL_DAYS || "30",
  10,
);
const SESSION_TTL_MS =
  (Number.isFinite(configuredSessionDays) && configuredSessionDays > 0
    ? configuredSessionDays
    : 30) *
  24 *
  60 *
  60 *
  1000;

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

export const isEntitlementCurrent = (entitlement, now = new Date()) =>
  Boolean(
    entitlement &&
      entitlement.status === "active" &&
      (!entitlement.expiresAt || new Date(entitlement.expiresAt) > now),
  );

export const createAuthSession = async ({
  userId = null,
  role,
  adminUsername = "",
}) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await AuthSession.create({
    tokenHash: hashToken(token),
    userId,
    role,
    adminUsername,
    expiresAt,
  });

  return { token, expiresAt, sessionId: session._id };
};

export const getRequestIdentity = async (request) => {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);

  if (!match || match[1].length !== 43) {
    return null;
  }

  const session = await AuthSession.findOne({
    tokenHash: hashToken(match[1]),
    expiresAt: { $gt: new Date() },
  }).lean();

  if (!session) {
    return null;
  }

  if (session.role === "admin") {
    return {
      role: "admin",
      adminUsername: session.adminUsername,
      sessionId: session._id,
    };
  }

  const user = await User.findById(session.userId);
  if (!user || user.blocked) {
    await AuthSession.deleteOne({ _id: session._id });
    return null;
  }

  return {
    role: "user",
    userId: user._id,
    user,
    email: user.email,
    sessionId: session._id,
  };
};

export const hasPremiumAccess = async (userId, moduleName) => {
  if (!userId || !["DSA", "PRACTICE"].includes(moduleName)) {
    return false;
  }

  const entitlement = await Entitlement.findOne({
    userId,
    module: moduleName,
    status: "active",
  })
    .select("status expiresAt")
    .lean();
  return isEntitlementCurrent(entitlement);
};

export const requirePremiumModule = (moduleName) => async (request) => {
  const identity = await getRequestIdentity(request);

  if (!identity) {
    return {
      allowed: false,
      statusCode: 403,
      body: {
        code: "PREMIUM_REQUIRED",
        message: `Active ${moduleName} premium access is required.`,
        module: moduleName,
      },
    };
  }

  if (
    identity.role !== "admin" &&
    (identity.role !== "user" ||
      !(await hasPremiumAccess(identity.userId, moduleName)))
  ) {
    return {
      allowed: false,
      statusCode: 403,
      body: {
        code: "PREMIUM_REQUIRED",
        message: `Active ${moduleName} premium access is required.`,
        module: moduleName,
      },
    };
  }

  return { allowed: true, identity };
};

export const getRequestEntitlementModules = async (request) => {
  const identity = await getRequestIdentity(request);

  if (!identity) {
    return { identity: null, modules: [] };
  }
  if (identity.role === "admin") {
    return { identity, modules: ["DSA", "PRACTICE"] };
  }
  if (identity.role !== "user") {
    return { identity: null, modules: [] };
  }

  const rows = await Entitlement.find({
    userId: identity.userId,
    status: "active",
  })
    .select("module status expiresAt")
    .lean();

  return {
    identity,
    modules: rows
      .filter((row) => isEntitlementCurrent(row))
      .map((row) => row.module),
  };
};
