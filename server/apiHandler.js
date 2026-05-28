/* eslint-env node */
import mongoose from "mongoose";
import crypto from "node:crypto";
import { Question, User, connectDb } from "./db.js";

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
const registerOtps = new Map();
let smtpReady = false;
let smtpLastError = "";
const mailProvider = (process.env.MAIL_PROVIDER || "resend").trim().toLowerCase();

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

const createRegisterRecord = (email) => {
  const otp = makeOtp();
  const otpHash = crypto.createHash("sha256").update(otp).digest("hex");

  registerOtps.set(email, {
    otpHash,
    expiresAt: Date.now() + RESET_OTP_EXPIRY_MS,
  });

  return otp;
};

const readRegisterRecord = (email) => {
  const record = registerOtps.get(email);

  if (!record) {
    return null;
  }

  if (Date.now() > record.expiresAt) {
    registerOtps.delete(email);
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

const isResendConfigured = () => {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  const from = (process.env.RESEND_FROM || process.env.SMTP_FROM || "").trim();
  return Boolean(apiKey && from);
};

export const verifySmtpConnection = async () => {
  try {
    if (mailProvider !== "resend") {
      throw new Error("Unsupported MAIL_PROVIDER. Set MAIL_PROVIDER=resend.");
    }
    const apiKey = (process.env.RESEND_API_KEY || "").trim();
    const from = (process.env.RESEND_FROM || process.env.SMTP_FROM || "").trim();
    if (!apiKey || !from) {
      throw new Error("Resend is not configured. Add RESEND_API_KEY and RESEND_FROM in backend/.env.");
    }
    smtpReady = true;
    smtpLastError = "";
    return true;
  } catch (error) {
    smtpReady = false;
    smtpLastError = error?.message || "Resend verification failed.";
    throw error;
  }
};

const sendOtpEmail = async ({ email, otp, subject, title }) => {
  const text = `Your OTP is ${otp}. It is valid for 10 minutes.`;
  const html = `<p>${title}</p><p>Your OTP is <strong>${otp}</strong>.</p><p>It is valid for 10 minutes.</p>`;

  await sendWithResend({ email, subject, html, text });
};

const sendResetOtpEmail = async (email, otp) =>
  sendOtpEmail({
    email,
    otp,
    subject: "Online Quiz password reset OTP",
    title: "Use this OTP to reset your password.",
  });

const sendRegisterOtpEmail = async (email, otp) =>
  sendOtpEmail({
    email,
    otp,
    subject: "Online Quiz email verification OTP",
    title: "Use this OTP to verify your email and complete registration.",
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
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
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

  if (request.method === "POST" && pathname === "/api/auth/request-register-otp") {
    const body = await readRequestJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!email) {
      sendJson(response, 400, { message: "Email is required." });
      return true;
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      sendJson(response, 409, { message: "This email is already registered." });
      return true;
    }

    const otp = createRegisterRecord(email);
    await sendRegisterOtpEmail(email, otp);

    sendJson(response, 200, { message: "Verification OTP sent to your email." });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/auth/register-with-otp") {
    const body = await readRequestJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const stats = body.stats || {};
    const resume = body.resume || {};

    if (!name || !email || !password || !otp) {
      sendJson(response, 400, { message: "Name, email, password and OTP are required." });
      return true;
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      sendJson(response, 409, { message: "This email is already registered." });
      return true;
    }

    const record = readRegisterRecord(email);

    if (!record) {
      sendJson(response, 400, { message: "OTP expired or not requested. Please request a new OTP." });
      return true;
    }

    const providedOtpHash = crypto.createHash("sha256").update(otp).digest("hex");

    if (providedOtpHash !== record.otpHash) {
      sendJson(response, 401, { message: "OTP is incorrect." });
      return true;
    }

    await User.create({
      name,
      email,
      username,
      password,
      stats,
      resume,
    });

    registerOtps.delete(email);
    sendJson(response, 201, { message: "User created." });
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
    const { category = "", question = "", options = [], answer = "" } = body;

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
    });

    sendJson(response, 201, { message: "Question created." });
    return true;
  }

  const questionId = getIdFromPath(pathname, "questions");

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
