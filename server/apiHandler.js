/* eslint-env node */
import mongoose from "mongoose";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ContestSettings, Question, User, connectDb } from "./db.js";

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  response.end(JSON.stringify(payload));
};

const readRequestJson = async (request) =>
  new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;
    });

    request.on("end", () => {
      if (!rawBody.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });

const RESET_OTP_EXPIRY_MS = 10 * 60 * 1000;
const passwordResetOtps = new Map();
let smtpReady = false;
let smtpLastError = "";
const mailProvider = (process.env.MAIL_PROVIDER || "resend").trim().toLowerCase();
let smtpTransporter = null;

const makeOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const createResetRecord = (email) => {
  const otp = makeOtp();
  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");

  passwordResetOtps.set(email, {
    otpHash,
    expiresAt: Date.now() + RESET_OTP_EXPIRY_MS,
  });

  return otp;
};

const readResetRecord = (email) => {
  const record = passwordResetOtps.get(email);

  if (!record) {
    return null;
  }

  if (Date.now() > record.expiresAt) {
    passwordResetOtps.delete(email);
    return null;
  }

  return record;
};

const sendWithResend = async ({ email, subject, html, text }) => {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.RESEND_FROM || process.env.SMTP_FROM || "").trim();

  if (!apiKey || !from) {
    throw new Error("Resend is not configured. Add RESEND_API_KEY and RESEND_FROM in backend/.env.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Resend API error (${response.status}): ${payload}`);
  }
};

const createSmtpTransporter = () => {
  if (smtpTransporter) {
    return smtpTransporter;
  }

  const host = (process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const user = (process.env.SMTP_USER || "").trim();
  const pass = (process.env.SMTP_PASS || "").trim();

  if (!host || !port || !user || !pass) {
    throw new Error("SMTP is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS in backend/.env.");
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return smtpTransporter;
};

const sendWithSmtp = async ({ email, subject, html, text }) => {
  const from = (process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();

  if (!from) {
    throw new Error("SMTP_FROM is not configured. Add SMTP_FROM in backend/.env.");
  }

  await createSmtpTransporter().sendMail({
    from,
    to: email,
    subject,
    html,
    text,
  });
};

const isResendConfigured = () => {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.RESEND_FROM || process.env.SMTP_FROM || "").trim();
  return Boolean(apiKey && from);
};

export const verifySmtpConnection = async () => {
  try {
    if (mailProvider === "smtp") {
      await createSmtpTransporter().verify();
      smtpReady = true;
      smtpLastError = "";
      return true;
    }

    if (mailProvider === "resend") {
      const apiKey = (process.env.RESEND_API_KEY || "").trim();
      const from = (process.env.RESEND_FROM || process.env.SMTP_FROM || "").trim();
      if (!apiKey || !from) {
        throw new Error("Resend is not configured. Add RESEND_API_KEY and RESEND_FROM in backend/.env.");
      }
      smtpReady = true;
      smtpLastError = "";
      return true;
    }

    throw new Error("Unsupported MAIL_PROVIDER. Set MAIL_PROVIDER=smtp or MAIL_PROVIDER=resend.");
  } catch (error) {
    smtpReady = false;
    smtpLastError = error?.message || "Mail verification failed.";
    throw error;
  }
};

const sendOtpEmail = async ({ email, otp, subject, title }) => {
  const text = `Your OTP is ${otp}. It is valid for 10 minutes.`;
  const html = `<p>${title}</p><p>Your OTP is <strong>${otp}</strong>.</p><p>It is valid for 10 minutes.</p>`;

  if (mailProvider === "smtp") {
    await sendWithSmtp({ email, subject, html, text });
    return;
  }

  await sendWithResend({ email, subject, html, text });
};

const sendResetOtpEmail = async (email, otp) =>
  sendOtpEmail({
     from: "Quiz App <noreply@yourdomain.com>",
    email,
    otp,
    subject: "Online Quiz password reset OTP",
    title: "Use this OTP to reset your password.",
  });

const normalizeUser = (doc) => ({
  id: doc._id.toString(),
  name: doc.name,
  email: doc.email,
  username: doc.username || "",
  password: doc.password,
  photo: doc.photo || "",
  blocked: Boolean(doc.blocked),
  stats: doc.stats || {},
  resume: doc.resume || {},
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const normalizeQuestion = (doc) => ({
  id: doc._id.toString(),
  category: doc.category,
  question: doc.question,
  options: Array.isArray(doc.options) ? doc.options : [],
  answer: doc.answer,
  section: doc.section || "both",
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const normalizeContestSettings = (doc) => ({
  contestName: doc?.contestName?.trim() || "Weekly Contest",
  contestQuestionCount: doc?.contestQuestionCount ?? 10,
  contestDurationSeconds:
    doc?.contestDurationSeconds ??
    ((doc?.contestQuestionCount ?? 10) * (doc?.contestSecondsPerQuestion ?? 20)),
  isScheduled: Boolean(doc?.isScheduled),
  startAt: doc?.startAt || null,
  endAt: doc?.endAt || null,
  selectedQuestionIds: Array.isArray(doc?.selectedQuestionIds) ? doc.selectedQuestionIds : [],
  showLeaderboardToUsers: Boolean(doc?.showLeaderboardToUsers),
});

const getIdFromPath = (pathname, resource) => {
  const match = pathname.match(new RegExp(`^/api/${resource}/([a-fA-F0-9]{24})$`));
  return match ? match[1] : null;
};

const handleUsers = async (request, response, pathname) => {
  if (request.method === "GET" && pathname === "/api/users") {
    const rows = await User.find({}).sort({ createdAt: 1 });
    sendJson(response, 200, rows.map(normalizeUser));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/users") {
    const body = await readRequestJson(request);
    const {
      name = "",
      email = "",
      username = "",
      password = "",
      photo = "",
      blocked = false,
      stats = {},
      resume = {},
    } = body;

    if (!name.trim() || !email.trim() || !password) {
      sendJson(response, 400, { message: "name, email and password are required." });
      return true;
    }

    await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      username: username.trim(),
      password,
      photo,
      blocked: Boolean(blocked),
      stats: stats || {},
      resume: resume || {},
    });

    sendJson(response, 201, { message: "User created." });
    return true;
  }

  const userId = getIdFromPath(pathname, "users");

  if (request.method === "PATCH" && userId) {
    const body = await readRequestJson(request);
    const allowedFields = ["name", "email", "username", "password", "photo", "blocked", "stats", "resume"];
    const updates = {};

    allowedFields.forEach((field) => {
      if (!(field in body)) {
        return;
      }

      const value = body[field];

      if (field === "name" || field === "username") {
        updates[field] = typeof value === "string" ? value.trim() : "";
        return;
      }

      if (field === "email" && typeof value === "string") {
        updates.email = value.trim().toLowerCase();
        return;
      }

      if (field === "blocked") {
        updates.blocked = Boolean(value);
        return;
      }

      updates[field] = value ?? null;
    });

    if (!Object.keys(updates).length) {
      sendJson(response, 400, { message: "No valid fields provided." });
      return true;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updates, { new: true });

    if (!updatedUser) {
      sendJson(response, 404, { message: "User not found." });
      return true;
    }

    sendJson(response, 200, { message: "User updated.", user: normalizeUser(updatedUser) });
    return true;
  }

  if (request.method === "DELETE" && userId) {
    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      sendJson(response, 404, { message: "User not found." });
      return true;
    }

    sendJson(response, 200, { message: "User deleted." });
    return true;
  }

  return false;
};

const handleAuth = async (request, response, pathname) => {
  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readRequestJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) {
      sendJson(response, 400, { message: "Email and password are required." });
      return true;
    }

    const user = await User.findOne({ email, password });

    if (!user) {
      sendJson(response, 401, { message: "Email or password is incorrect." });
      return true;
    }

    if (user.blocked) {
      sendJson(response, 403, { message: "Your account is blocked. Please contact the admin." });
      return true;
    }

    sendJson(response, 200, { message: "Login successful.", user: normalizeUser(user) });
    return true;
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/auth/request-password-reset" || pathname === "/api/auth/send-otp")
  ) {
    const body = await readRequestJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      sendJson(response, 400, { message: "Email is required." });
      return true;
    }

    const user = await User.findOne({ email });

    if (!user) {
      sendJson(response, 404, { message: "No account found with this email." });
      return true;
    }

    const otp = createResetRecord(email);
    await sendResetOtpEmail(email, otp);

    sendJson(response, 200, { message: "OTP sent to your email." });
    return true;
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/auth/reset-password" || pathname === "/api/auth/verify-otp-reset")
  ) {
    const body = await readRequestJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !otp || !password) {
      sendJson(response, 400, { message: "Email, OTP and new password are required." });
      return true;
    }

    const user = await User.findOne({ email });

    if (!user) {
      sendJson(response, 404, { message: "No account found with this email." });
      return true;
    }

    const record = readResetRecord(email);

    if (!record) {
      sendJson(response, 400, { message: "OTP expired or not requested. Please request a new OTP." });
      return true;
    }

    const providedOtpHash = crypto.createHash("sha256").update(otp).digest("hex");

    if (providedOtpHash !== record.otpHash) {
      sendJson(response, 401, { message: "OTP is incorrect." });
      return true;
    }

    user.password = password;
    await user.save();
    passwordResetOtps.delete(email);

    sendJson(response, 200, { message: "Password updated successfully." });
    return true;
  }

  return false;
};

const handleQuestions = async (request, response, pathname) => {
  if (request.method === "GET" && pathname === "/api/questions") {
    const rows = await Question.find({}).sort({ createdAt: 1 });
    sendJson(response, 200, rows.map(normalizeQuestion));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/questions") {
    const body = await readRequestJson(request);
    const { category = "", question = "", options = [], answer = "", section = "both" } = body;

    if (!category.trim() || !question.trim() || !Array.isArray(options) || options.length < 2 || !answer.trim()) {
      sendJson(response, 400, {
        message: "category, question, options(2+) and answer are required.",
      });
      return true;
    }

    await Question.create({
      category: category.trim(),
      question: question.trim(),
      options: options.map((item) => String(item).trim()).filter(Boolean),
      answer: answer.trim(),
      section: ["quiz", "contest", "both"].includes(section) ? section : "both",
    });

    sendJson(response, 201, { message: "Question created." });
    return true;
  }

  const questionId = getIdFromPath(pathname, "questions");

  if (request.method === "PATCH" && questionId) {
    const body = await readRequestJson(request);
    const updates = {};

    if (typeof body.category === "string") {
      updates.category = body.category.trim();
    }

    if (typeof body.question === "string") {
      updates.question = body.question.trim();
    }

    if (Array.isArray(body.options)) {
      updates.options = body.options.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof body.answer === "string") {
      updates.answer = body.answer.trim();
    }

    if (typeof body.section === "string") {
      updates.section = ["quiz", "contest", "both"].includes(body.section) ? body.section : "both";
    }

    if (!Object.keys(updates).length) {
      sendJson(response, 400, { message: "No valid fields provided." });
      return true;
    }

    const updatedQuestion = await Question.findByIdAndUpdate(questionId, updates, { new: true });

    if (!updatedQuestion) {
      sendJson(response, 404, { message: "Question not found." });
      return true;
    }

    sendJson(response, 200, { message: "Question updated.", question: normalizeQuestion(updatedQuestion) });
    return true;
  }

  if (request.method === "DELETE" && questionId) {
    const deletedQuestion = await Question.findByIdAndDelete(questionId);

    if (!deletedQuestion) {
      sendJson(response, 404, { message: "Question not found." });
      return true;
    }

    sendJson(response, 200, { message: "Question deleted." });
    return true;
  }

  return false;
};

const getContestSettingsDoc = async () => {
  const existing = await ContestSettings.findOne({ key: "default" });

  if (existing) {
    return existing;
  }

  return ContestSettings.create({ key: "default" });
};

const handleContestSettings = async (request, response, pathname) => {
  if (pathname !== "/api/contest-settings") {
    return false;
  }

  if (request.method === "GET") {
    const settingsDoc = await getContestSettingsDoc();
    sendJson(response, 200, normalizeContestSettings(settingsDoc));
    return true;
  }

  if (request.method === "PATCH") {
    const body = await readRequestJson(request);
    const updates = {};

    if ("contestName" in body) {
      const name = typeof body.contestName === "string" ? body.contestName.trim() : "";
      updates.contestName = name || "Weekly Contest";
    }

    if (typeof body.contestQuestionCount === "number") {
      updates.contestQuestionCount = Math.max(1, Math.min(100, Math.floor(body.contestQuestionCount)));
    }

    if (typeof body.contestDurationSeconds === "number") {
      updates.contestDurationSeconds = Math.max(30, Math.min(14400, Math.floor(body.contestDurationSeconds)));
    }

    if (typeof body.isScheduled === "boolean") {
      updates.isScheduled = body.isScheduled;
    }

    if ("startAt" in body) {
      updates.startAt = body.startAt ? new Date(body.startAt) : null;
    }

    if ("endAt" in body) {
      updates.endAt = body.endAt ? new Date(body.endAt) : null;
    }

    if (Array.isArray(body.selectedQuestionIds)) {
      updates.selectedQuestionIds = body.selectedQuestionIds
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }

    if (typeof body.showLeaderboardToUsers === "boolean") {
      updates.showLeaderboardToUsers = body.showLeaderboardToUsers;
    }

    const settingsDoc = await getContestSettingsDoc();
    Object.assign(settingsDoc, updates);
    await settingsDoc.save();

    sendJson(response, 200, { message: "Contest settings updated.", settings: normalizeContestSettings(settingsDoc) });
    return true;
  }

  return false;
};

export const handleApiRequest = async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (!pathname.startsWith("/api/")) {
    return false;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
    response.end();
    return true;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      dbReadyState: mongoose.connection.readyState,
      mailReady: smtpReady,
      ...(smtpLastError ? { mailError: smtpLastError } : {}),
    });
    return true;
  }

  try {
    await connectDb();

    if (await handleUsers(request, response, pathname)) {
      return true;
    }

    if (await handleAuth(request, response, pathname)) {
      return true;
    }

    if (await handleQuestions(request, response, pathname)) {
      return true;
    }

    if (await handleContestSettings(request, response, pathname)) {
      return true;
    }

    sendJson(response, 404, { message: "API route not found." });
    return true;
  } catch (error) {
    const isDuplicateEmail = error?.code === 11000;
    const isInvalidObjectId = error instanceof mongoose.Error.CastError;
    const isConfigError =
      /MONGODB_URI is missing/i.test(error?.message || "") ||
      /URI|connection string|SRV|MongoParseError|Invalid scheme/i.test(error?.message || "");
    const isDbConnectionError =
      /Server selection timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|timed out|querySrv|SSL|authentication failed|bad auth/i.test(
        error?.message || "",
      );
    const isResendError = /Resend API error|Resend is not configured/i.test(error?.message || "");
    const statusCode = isDuplicateEmail ? 409 : isInvalidObjectId ? 400 : 500;
    const message = isDuplicateEmail
      ? "This email is already registered."
      : isInvalidObjectId
        ? "Invalid record id."
        : isConfigError
          ? `Database configuration error: ${error.message}`
          : isDbConnectionError
            ? `Database connection failed: ${error.message}. Check MONGODB_URI, MongoDB Atlas Network Access (IP allowlist), and database user credentials.`
          : isResendError
            ? `Email delivery failed: ${error.message}`
          : "Database error.";

    sendJson(response, statusCode, { message });
    return true;
  }
};
