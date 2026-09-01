/* eslint-env node */
import mongoose from "mongoose";
import crypto from "node:crypto";
import { Resend } from "resend";
import {
  isSupportedCompilerLanguage,
  runCompiledCode,
  verifyCompilerSetup,
} from "./compiler.js";
import {
  ContestSettings,
  Language,
  Module,
  PracticeQuestion,
  PracticeQuestionData,
  Problem,
  Question,
  Submission,
  User,
  connectDb,
} from "./db.js";

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
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
      } catch (error) {
        void error;
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });

const RESET_OTP_EXPIRY_MS = 10 * 60 * 1000;
const passwordResetOtps = new Map();
let mailReady = false;
let mailLastError = "";
let resendClient = null;

const makeOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const getErrorMessage = (error, fallback) =>
  error && typeof error.message === "string" && error.message.trim()
    ? error.message
    : fallback;

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

const getResendClient = () => {
  const apiKey = (process.env.RESEND_API_KEY || "").trim();

  if (!apiKey) {
    throw new Error(
      "Resend is not configured. Add RESEND_API_KEY in backend/.env.",
    );
  }

  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }

  return resendClient;
};

const sendWithResend = async ({ email, subject, html, text }) => {
  const from = (process.env.RESEND_FROM || "").trim();

  if (!from) {
    throw new Error(
      "Resend is not configured. Add RESEND_FROM in backend/.env.",
    );
  }

  const resend = getResendClient();
  const { error } = await resend.emails.send({
    from,
    to: [email],
    subject,
    html,
    text,
  });

  if (error) {
    throw new Error(`Resend API error: ${error.message}`);
  }
};

export const verifyResendConnection = async () => {
  try {
    getResendClient();

    const from = (process.env.RESEND_FROM || "").trim();
    if (!from) {
      throw new Error(
        "Resend is not configured. Add RESEND_FROM in backend/.env.",
      );
    }

    mailReady = true;
    mailLastError = "";
    return true;
  } catch (error) {
    mailReady = false;
    mailLastError = getErrorMessage(error, "Resend verification failed.");
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
    subject: "Code Sniper password reset OTP",
    title: "Use this OTP to reset your password.",
  });

const handleCompile = async (request, response, pathname) => {
  if (pathname !== "/api/compile") {
    return false;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { message: "Use POST to run code." });
    return true;
  }

  const body = await readRequestJson(request);
  const language = String(body.language || "")
    .trim()
    .toLowerCase();
  const code = String(body.code || "");
  const stdin = String(body.stdin || "");

  if (!isSupportedCompilerLanguage(language)) {
    sendJson(response, 400, {
      message: "Supported server languages: python, java, cpp.",
    });
    return true;
  }

  if (!code.trim()) {
    sendJson(response, 400, { message: "Please enter code to run." });
    return true;
  }

  if (code.length > 20000 || stdin.length > 5000) {
    sendJson(response, 413, { message: "Code or input is too large." });
    return true;
  }

  try {
    const result = await runCompiledCode({ language, code, stdin });
    sendJson(response, 200, result);
  } catch (error) {
    const payload = {
      message: error.message || "Compiler service could not run this code.",
    };

    if (error.code) {
      payload.code = error.code;
    }

    if (error.tool) {
      payload.tool = error.tool;
    }

    sendJson(response, error.statusCode || 500, payload);
  }

  return true;
};

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

const normalizeProblem = (doc) => {
  const problem = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    id: problem._id.toString(),
    title: problem.title,
    slug: problem.slug,
    difficulty: problem.difficulty,
    status: problem.status || "published",
    programmingLanguage: problem.programmingLanguage || problem.language || "",
    description: problem.description || "",
    notes: problem.notes || "",
    inputFormat: problem.inputFormat || "",
    outputFormat: problem.outputFormat || "",
    constraints: problem.constraints || "",
    sampleTestCases: Array.isArray(problem.sampleTestCases)
      ? problem.sampleTestCases
      : [],
    hiddenTestCases: Array.isArray(problem.hiddenTestCases)
      ? problem.hiddenTestCases
      : [],
    starterCode: problem.starterCode || {},
    starterCodeTemplate: problem.starterCodeTemplate || "",
    solution: problem.solution || "",
    tags: Array.isArray(problem.tags) ? problem.tags : [],
    timeLimit: problem.timeLimit || "",
    memoryLimit: problem.memoryLimit || "",
    explanation: problem.explanation || "",
    createdAt: problem.createdAt,
    updatedAt: problem.updatedAt,
  };
};

const normalizeContestSettings = (doc) => ({
  contestName:
    doc && doc.contestName ? String(doc.contestName).trim() : "Weekly Contest",
  contestQuestionCount:
    doc && doc.contestQuestionCount != null ? doc.contestQuestionCount : 10,
  contestDurationSeconds:
    doc && doc.contestDurationSeconds != null
      ? doc.contestDurationSeconds
      : (doc && doc.contestQuestionCount != null
          ? doc.contestQuestionCount
          : 10) *
        (doc && doc.contestSecondsPerQuestion != null
          ? doc.contestSecondsPerQuestion
          : 20),
  isScheduled: Boolean(doc && doc.isScheduled),
  startAt: (doc && doc.startAt) || null,
  endAt: (doc && doc.endAt) || null,
  selectedQuestionIds:
    doc && Array.isArray(doc.selectedQuestionIds)
      ? doc.selectedQuestionIds
      : [],
  showLeaderboardToUsers: Boolean(doc && doc.showLeaderboardToUsers),
  quizName: doc && doc.quizName ? String(doc.quizName).trim() : "Practice Quiz",
  quizQuestionCount:
    doc && doc.quizQuestionCount != null ? doc.quizQuestionCount : 10,
  quizDurationSeconds:
    doc && doc.quizDurationSeconds != null ? doc.quizDurationSeconds : 600,
  selectedQuizQuestionIds: Array.isArray(doc?.selectedQuizQuestionIds)
    ? doc.selectedQuizQuestionIds
    : [],
});

const handleVerifySolution = async (request, response, pathname) => {
  const match = pathname.match(/^\/api\/problems\/([^/]+)\/verify-solution$/);

  if (!match || request.method !== "POST") {
    return false;
  }

  const problemIdOrSlug = decodeURIComponent(match[1]);
  const body = await readRequestJson(request);
  const language = getCompilerLanguageKey(
    body.language || body.programmingLanguage || "",
  );
  const code = String(body.code || "");

  if (!isSupportedCompilerLanguage(language)) {
    sendJson(response, 400, {
      message: "Supported server languages: python, java, cpp.",
    });
    return true;
  }

  if (!code.trim()) {
    sendJson(response, 400, { message: "Please enter code to run." });
    return true;
  }

  const problem = await findProblemByIdOrSlug(problemIdOrSlug);

  if (!problem) {
    sendJson(response, 404, { message: "Problem not found." });
    return true;
  }

  const hiddenTestCases = Array.isArray(problem.hiddenTestCases)
    ? problem.hiddenTestCases
    : [];

  if (!hiddenTestCases.length) {
    sendJson(response, 200, {
      message: "No hidden verification tests are configured for this problem.",
      allPassed: false,
      passedCount: 0,
      totalCount: 0,
    });
    return true;
  }

  let passedCount = 0;
  let failed = false;

  for (const testCase of hiddenTestCases) {
    try {
      const result = await runCompiledCode({
        language,
        code,
        stdin: String(testCase.input || ""),
      });
      const actualOutput = normalizeVerificationOutput(result.output);
      const expectedOutput = normalizeVerificationOutput(testCase.output);

      if (actualOutput === expectedOutput) {
        passedCount += 1;
      } else {
        failed = true;
        break;
      }
    } catch {
      failed = true;
      break;
    }
  }

  sendJson(response, 200, {
    allPassed: !failed && passedCount === hiddenTestCases.length,
    passedCount,
    totalCount: hiddenTestCases.length,
  });
  return true;
};

const getIdFromPath = (pathname, resource) => {
  const match = pathname.match(
    new RegExp(`^/api/${resource}/([a-fA-F0-9]{24})$`),
  );
  return match ? match[1] : null;
};

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const cleanTextArray = (items) =>
  Array.isArray(items)
    ? items.map((item) => String(item).trim()).filter(Boolean)
    : String(items || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const cleanTestCases = (items) =>
  Array.isArray(items)
    ? items
        .map((item) => ({
          input: String(item?.input || ""),
          output: String(item?.output || ""),
          explanation: String(item?.explanation || ""),
        }))
        .filter(
          (item) =>
            item.input.trim() || item.output.trim() || item.explanation.trim(),
        )
    : [];

const cleanStarterCode = (starterCode = {}) => ({
  java: String(starterCode.java || ""),
  cpp: String(starterCode.cpp || ""),
  python: String(starterCode.python || ""),
  javascript: String(starterCode.javascript || ""),
});

const normalizeVerificationOutput = (value) =>
  String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();

const normalizeSubmission = (doc) => ({
  id: doc._id.toString(),
  problemId: doc.problemId?.toString() || "",
  problemSlug: doc.problemSlug || "",
  userEmail: doc.userEmail || "",
  username: doc.username || "",
  language: doc.language || "",
  status: doc.status || "",
  passedCount: doc.passedCount || 0,
  totalCount: doc.totalCount || 0,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const handleSubmitSolution = async (request, response, pathname) => {
  const match = pathname.match(/^\/api\/problems\/([^/]+)\/submit-solution$/);

  if (!match || request.method !== "POST") {
    return false;
  }

  const problemIdOrSlug = decodeURIComponent(match[1]);
  const body = await readRequestJson(request);
  const language = getCompilerLanguageKey(
    body.language || body.programmingLanguage || "",
  );
  const code = String(body.code || "");
  const userEmail =
    typeof body.userEmail === "string"
      ? body.userEmail.trim().toLowerCase()
      : "";
  const username =
    typeof body.username === "string" ? body.username.trim() : "";

  if (!isSupportedCompilerLanguage(language)) {
    sendJson(response, 400, {
      message: "Supported server languages: python, java, cpp.",
    });
    return true;
  }

  if (!code.trim()) {
    sendJson(response, 400, { message: "Please enter code to submit." });
    return true;
  }

  const problem = await findProblemByIdOrSlug(problemIdOrSlug);

  if (!problem) {
    sendJson(response, 404, { message: "Problem not found." });
    return true;
  }

  const hiddenTestCases = Array.isArray(problem.hiddenTestCases)
    ? problem.hiddenTestCases
    : [];

  if (!hiddenTestCases.length) {
    sendJson(response, 400, {
      message: "No hidden verification tests are configured for this problem.",
    });
    return true;
  }

  let passedCount = 0;
  let failed = false;

  for (const testCase of hiddenTestCases) {
    try {
      const result = await runCompiledCode({
        language,
        code,
        stdin: String(testCase.input || ""),
      });
      const actualOutput = normalizeVerificationOutput(result.output);
      const expectedOutput = normalizeVerificationOutput(testCase.output);

      if (actualOutput === expectedOutput) {
        passedCount += 1;
      } else {
        failed = true;
        break;
      }
    } catch {
      failed = true;
      break;
    }
  }

  if (!passedCount || failed || passedCount !== hiddenTestCases.length) {
    sendJson(response, 400, {
      message: "Solution did not pass all verification tests.",
      passedCount,
      totalCount: hiddenTestCases.length,
    });
    return true;
  }

  const submission = await Submission.create({
    problemId: problem._id,
    problemSlug: problem.slug,
    userEmail,
    username,
    language,
    code,
    status: "Accepted",
    passedCount,
    totalCount: hiddenTestCases.length,
  });

  sendJson(response, 201, {
    message: "Solution submitted and accepted.",
    submission: normalizeSubmission(submission),
  });
  return true;
};

const getCompilerLanguageKey = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (["java", "javac", "jvm"].includes(normalized)) {
    return "java";
  }

  if (["c++", "cpp", "c/c++", "c"].includes(normalized)) {
    return "cpp";
  }

  if (["python", "py"].includes(normalized)) {
    return "python";
  }

  return normalized;
};

const buildProblemPayload = (body, { partial = false } = {}) => {
  const payload = {};

  if (!partial || "title" in body) {
    payload.title = String(body.title || "").trim();
  }

  if (!partial || "slug" in body || "title" in body) {
    payload.slug = slugify(body.slug || body.title);
  }

  if (!partial || "difficulty" in body) {
    payload.difficulty = String(body.difficulty || "").trim();
  }

  if (!partial || "programmingLanguage" in body || "language" in body) {
    payload.programmingLanguage = String(
      body.programmingLanguage || body.language || "",
    ).trim();
  }

  if (!partial || "description" in body) {
    payload.description = String(body.description || "").trim();
  }

  [
    "notes",
    "inputFormat",
    "outputFormat",
    "constraints",
    "timeLimit",
    "memoryLimit",
    "explanation",
    "starterCodeTemplate",
    "solution",
  ].forEach((field) => {
    if (!partial || field in body) {
      payload[field] = String(body[field] || "").trim();
    }
  });

  if (!partial || "status" in body) {
    const status = String(body.status || "published").trim();
    payload.status = ["draft", "published"].includes(status)
      ? status
      : "published";
  }

  if (!partial || "sampleTestCases" in body) {
    payload.sampleTestCases = cleanTestCases(body.sampleTestCases);
  }

  if (!partial || "hiddenTestCases" in body) {
    payload.hiddenTestCases = cleanTestCases(body.hiddenTestCases);
  }

  if (!partial || "starterCode" in body) {
    payload.starterCode = cleanStarterCode(body.starterCode || {});
  }

  if (!partial || "tags" in body) {
    payload.tags = cleanTextArray(body.tags);
  }

  Object.keys(payload).forEach((key) => {
    if (partial && payload[key] === undefined) {
      delete payload[key];
    }
  });

  return payload;
};

const validateProblemPayload = (payload, { partial = false } = {}) => {
  if (!partial && !String(payload.difficulty || "").trim()) {
    return "difficulty is required.";
  }

  if (
    "difficulty" in payload &&
    payload.difficulty &&
    !["Easy", "Medium", "Hard"].includes(payload.difficulty)
  ) {
    return "difficulty must be Easy, Medium, or Hard.";
  }

  if ("slug" in payload && payload.slug === "") {
    return "slug is required when provided.";
  }

  if (
    "status" in payload &&
    payload.status &&
    !["draft", "published"].includes(payload.status)
  ) {
    return "status must be draft or published.";
  }

  return "";
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
      sendJson(response, 400, {
        message: "name, email and password are required.",
      });
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
    const allowedFields = [
      "name",
      "email",
      "username",
      "password",
      "photo",
      "blocked",
      "stats",
      "resume",
    ];
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

      updates[field] = value == null ? null : value;
    });

    if (!Object.keys(updates).length) {
      sendJson(response, 400, { message: "No valid fields provided." });
      return true;
    }

    const updatedUser = await User.findByIdAndUpdate(userId, updates, {
      new: true,
    });

    if (!updatedUser) {
      sendJson(response, 404, { message: "User not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "User updated.",
      user: normalizeUser(updatedUser),
    });
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
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
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
      sendJson(response, 403, {
        message: "Your account is blocked. Please contact the admin.",
      });
      return true;
    }

    sendJson(response, 200, {
      message: "Login successful.",
      user: normalizeUser(user),
    });
    return true;
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/auth/request-password-reset" ||
      pathname === "/api/auth/send-otp")
  ) {
    const body = await readRequestJson(request);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

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
    (pathname === "/api/auth/reset-password" ||
      pathname === "/api/auth/verify-otp-reset")
  ) {
    const body = await readRequestJson(request);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !otp || !password) {
      sendJson(response, 400, {
        message: "Email, OTP and new password are required.",
      });
      return true;
    }

    const user = await User.findOne({ email });

    if (!user) {
      sendJson(response, 404, { message: "No account found with this email." });
      return true;
    }

    const record = readResetRecord(email);

    if (!record) {
      sendJson(response, 400, {
        message: "OTP expired or not requested. Please request a new OTP.",
      });
      return true;
    }

    const providedOtpHash = crypto
      .createHash("sha256")
      .update(otp)
      .digest("hex");

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
    const {
      category = "",
      question = "",
      options = [],
      answer = "",
      section = "both",
    } = body;

    if (
      !category.trim() ||
      !question.trim() ||
      !Array.isArray(options) ||
      options.length < 2 ||
      !answer.trim()
    ) {
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
      updates.options = body.options
        .map((item) => String(item).trim())
        .filter(Boolean);
    }

    if (typeof body.answer === "string") {
      updates.answer = body.answer.trim();
    }

    if (typeof body.section === "string") {
      updates.section = ["quiz", "contest", "both"].includes(body.section)
        ? body.section
        : "both";
    }

    if (!Object.keys(updates).length) {
      sendJson(response, 400, { message: "No valid fields provided." });
      return true;
    }

    const updatedQuestion = await Question.findByIdAndUpdate(
      questionId,
      updates,
      { new: true },
    );

    if (!updatedQuestion) {
      sendJson(response, 404, { message: "Question not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "Question updated.",
      question: normalizeQuestion(updatedQuestion),
    });
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

const getProblemIdFromPath = (pathname) => {
  const match = pathname.match(/^\/api\/problems\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const findProblemByIdOrSlug = (idOrSlug) => {
  if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
    return Problem.findById(idOrSlug).lean();
  }

  return Problem.findOne({
    slug: String(idOrSlug || "")
      .trim()
      .toLowerCase(),
  }).lean();
};

const findExistingProblemSlug = async (slug, excludedId = "") => {
  if (!slug) {
    return null;
  }

  const query = { slug };

  if (excludedId && mongoose.Types.ObjectId.isValid(excludedId)) {
    query._id = { $ne: excludedId };
  }

  return Problem.findOne(query).select("_id");
};

const handleProblems = async (request, response, pathname, url) => {
  if (request.method === "GET" && pathname === "/api/problems") {
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10),
    );
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10)),
    );
    const search = (url.searchParams.get("search") || "").trim();
    const difficulty = (url.searchParams.get("difficulty") || "").trim();
    const programmingLanguage = (
      url.searchParams.get("programmingLanguage") ||
      url.searchParams.get("language") ||
      ""
    ).trim();
    const status = (url.searchParams.get("status") || "").trim();
    const tag = (url.searchParams.get("tag") || "").trim();
    const query = {};

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { slug: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
      ];
    }

    if (difficulty) {
      query.difficulty = difficulty;
    }

    if (programmingLanguage) {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            {
              programmingLanguage: {
                $regex: `^${programmingLanguage}$`,
                $options: "i",
              },
            },
            { language: { $regex: `^${programmingLanguage}$`, $options: "i" } },
          ],
        },
      ];
    }

    if (status) {
      query.status = status;
    }

    if (tag) {
      query.tags = { $regex: `^${tag}$`, $options: "i" };
    }

    const [rows, total] = await Promise.all([
      Problem.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Problem.countDocuments(query),
    ]);

    sendJson(response, 200, {
      items: rows.map(normalizeProblem),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
    return true;
  }

  const problemId = getProblemIdFromPath(pathname);

  if (request.method === "GET" && problemId) {
    const problem = await findProblemByIdOrSlug(problemId);

    if (!problem) {
      sendJson(response, 404, { message: "Problem not found." });
      return true;
    }

    sendJson(response, 200, normalizeProblem(problem));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/problems") {
    const body = await readRequestJson(request);
    const payload = buildProblemPayload(body);
    const validationError = validateProblemPayload(payload);

    if (validationError) {
      sendJson(response, 400, { message: validationError });
      return true;
    }

    if (await findExistingProblemSlug(payload.slug)) {
      sendJson(response, 409, {
        message: "This problem slug is already used.",
      });
      return true;
    }

    const problem = await Problem.create(payload);
    sendJson(response, 201, {
      message: "Problem created.",
      problem: normalizeProblem(problem),
    });
    return true;
  }

  if (request.method === "PUT" && problemId) {
    const body = await readRequestJson(request);
    const payload = buildProblemPayload(body);
    const validationError = validateProblemPayload(payload);

    if (validationError) {
      sendJson(response, 400, { message: validationError });
      return true;
    }

    if (await findExistingProblemSlug(payload.slug, problemId)) {
      sendJson(response, 409, {
        message: "This problem slug is already used.",
      });
      return true;
    }

    const updatedProblem = await Problem.findByIdAndUpdate(problemId, payload, {
      new: true,
      runValidators: true,
    });

    if (!updatedProblem) {
      sendJson(response, 404, { message: "Problem not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "Problem updated.",
      problem: normalizeProblem(updatedProblem),
    });
    return true;
  }

  if (request.method === "DELETE" && problemId) {
    const deletedProblem = await Problem.findByIdAndDelete(problemId);

    if (!deletedProblem) {
      sendJson(response, 404, { message: "Problem not found." });
      return true;
    }

    sendJson(response, 200, { message: "Problem deleted." });
    return true;
  }

  return false;
};

const DEFAULT_LANGUAGES = [
  { name: "Java", slug: "java", icon: "☕", order: 0 },
  { name: "C++", slug: "cpp", icon: "⚡", order: 1 },
  { name: "Python", slug: "python", icon: "🐍", order: 2 },
  { name: "JavaScript", slug: "javascript", icon: "📜", order: 3 },
  { name: "C", slug: "c", icon: "🔧", order: 4 },
  { name: "SQL", slug: "sql", icon: "🗄", order: 5 },
];

const ensureDefaultLanguages = async () => {
  const count = await Language.countDocuments();

  if (count === 0) {
    await Language.insertMany(DEFAULT_LANGUAGES);
  }
};

const normalizeLanguage = (doc) => {
  const row = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    id: row._id.toString(),
    name: row.name,
    slug: row.slug,
    icon: row.icon || "",
    order: row.order ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const normalizeModule = (doc) => {
  const row = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    id: row._id.toString(),
    languageId: row.languageId?.toString?.() || String(row.languageId || ""),
    title: row.title,
    description: row.description || "",
    order: row.order ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const normalizePracticeQuestion = (doc, problem = null) => {
  const row = typeof doc.toObject === "function" ? doc.toObject() : doc;

  return {
    id: row._id.toString(),
    moduleId: row.moduleId?.toString?.() || String(row.moduleId || ""),
    questionId: row.questionId?.toString?.() || "",
    problemId: row.problemId?.toString?.() || String(row.problemId || ""),
    questionType: row.questionType || (row.questionId ? "practice" : "global"),
    order: row.order ?? 0,
    status: row.status || "active",
    question: problem ? normalizeProblem(problem) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const getActiveQuestionCountsByLanguage = async (languages) => {
  const modules = await Module.find({
    languageId: { $in: languages.map((language) => language._id) },
  })
    .select("_id languageId")
    .lean();
  const moduleLanguageMap = new Map(
    modules.map((moduleDoc) => [
      moduleDoc._id.toString(),
      moduleDoc.languageId.toString(),
    ]),
  );
  const activeCounts = modules.length
    ? await PracticeQuestion.aggregate([
        {
          $match: {
            moduleId: { $in: modules.map((moduleDoc) => moduleDoc._id) },
            status: "active",
          },
        },
        { $group: { _id: "$moduleId", count: { $sum: 1 } } },
      ])
    : [];
  const counts = new Map();
  activeCounts.forEach((row) => {
    const languageId = moduleLanguageMap.get(row._id.toString());
    if (languageId)
      counts.set(languageId, (counts.get(languageId) || 0) + row.count);
  });
  return counts;
};

const getResolvedPracticeQuestions = async (moduleId, status) => {
  const rows = await PracticeQuestion.find(
    status ? { moduleId, status } : { moduleId },
  )
    .sort({ order: 1, createdAt: 1 })
    .lean();
  const globalIds = rows
    .filter(
      (row) =>
        row.questionType === "global" || (!row.questionType && row.problemId),
    )
    .map((row) => row.problemId)
    .filter(Boolean);
  const practiceIds = rows
    .filter(
      (row) =>
        row.questionType === "practice" ||
        (!row.questionType && row.questionId),
    )
    .map((row) => row.questionId)
    .filter(Boolean);
  const [problems, practiceData] = await Promise.all([
    globalIds.length
      ? Problem.find({ _id: { $in: globalIds } }).lean()
      : Promise.resolve([]),
    practiceIds.length
      ? PracticeQuestionData.find({ _id: { $in: practiceIds } }).lean()
      : Promise.resolve([]),
  ]);
  const problemMap = new Map(
    problems.map((problem) => [problem._id.toString(), problem]),
  );
  const dataMap = new Map(
    practiceData.map((question) => [question._id.toString(), question]),
  );
  return rows.flatMap((row) => {
    const type = row.questionType || (row.questionId ? "practice" : "global");
    const question =
      type === "practice"
        ? dataMap.get(String(row.questionId))
        : problemMap.get(String(row.problemId));
    return question ? [normalizePracticeQuestion(row, question)] : [];
  });
};

const handleStudentPractice = async (request, response, pathname) => {
  if (request.method !== "GET" || !pathname.startsWith("/api/practice/"))
    return false;
  if (pathname === "/api/practice/languages") {
    await ensureDefaultLanguages();
    const languages = await Language.find({})
      .sort({ order: 1, name: 1 })
      .lean();
    const counts = await getActiveQuestionCountsByLanguage(languages);
    sendJson(response, 200, {
      items: languages.map((language) => ({
        ...normalizeLanguage(language),
        questionCount: counts.get(language._id.toString()) || 0,
      })),
    });
    return true;
  }
  const modulesMatch = pathname.match(
    /^\/api\/practice\/languages\/([^/]+)\/modules$/,
  );
  if (modulesMatch) {
    const language = await Language.findOne({
      slug: decodeURIComponent(modulesMatch[1]),
    }).lean();
    if (!language) {
      sendJson(response, 404, { message: "Learning path not found." });
      return true;
    }
    const modules = await Module.find({ languageId: language._id })
      .sort({ order: 1, title: 1 })
      .lean();
    const counts = await Promise.all(
      modules.map(async (moduleDoc) => [
        moduleDoc._id.toString(),
        await PracticeQuestion.countDocuments({
          moduleId: moduleDoc._id,
          status: "active",
        }),
      ]),
    );
    const countMap = new Map(counts);
    sendJson(response, 200, {
      language: normalizeLanguage(language),
      items: modules.map((moduleDoc) => ({
        ...normalizeModule(moduleDoc),
        questionCount: countMap.get(moduleDoc._id.toString()) || 0,
      })),
    });
    return true;
  }
  const questionsMatch = pathname.match(
    /^\/api\/practice\/languages\/([^/]+)\/modules\/([^/]+)\/questions$/,
  );
  if (questionsMatch) {
    const language = await Language.findOne({
      slug: decodeURIComponent(questionsMatch[1]),
    }).lean();
    const moduleDoc = language
      ? await Module.findOne({
          _id: decodeURIComponent(questionsMatch[2]),
          languageId: language._id,
        }).lean()
      : null;
    if (!moduleDoc) {
      sendJson(response, 404, {
        message: "Module not found in this learning path.",
      });
      return true;
    }
    sendJson(response, 200, {
      language: normalizeLanguage(language),
      module: normalizeModule(moduleDoc),
      items: await getResolvedPracticeQuestions(moduleDoc._id, "active"),
    });
    return true;
  }
  return false;
};

const normalizePracticeQuestionData = (doc) => normalizeProblem(doc);

const findPracticeQuestionDataByIdOrSlug = async (
  idOrSlug,
  excludedId = "",
) => {
  if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
    const doc = await PracticeQuestionData.findById(idOrSlug);
    return doc;
  }

  const query = { slug: idOrSlug };
  if (mongoose.Types.ObjectId.isValid(excludedId)) {
    query._id = { $ne: excludedId };
  }

  return PracticeQuestionData.findOne(query);
};

const handlePracticeQuestionData = async (request, response, pathname, url) => {
  if (request.method === "GET" && pathname === "/api/practice-question-data") {
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10),
    );
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "20", 10)),
    );
    const search = (url.searchParams.get("search") || "").trim();
    const difficulty = (url.searchParams.get("difficulty") || "").trim();
    const programmingLanguage = (
      url.searchParams.get("programmingLanguage") ||
      url.searchParams.get("language") ||
      ""
    ).trim();
    const status = (url.searchParams.get("status") || "").trim();
    const tag = (url.searchParams.get("tag") || "").trim();
    const query = {};

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { slug: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
      ];
    }

    if (difficulty) {
      query.difficulty = difficulty;
    }

    if (programmingLanguage) {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            {
              programmingLanguage: {
                $regex: `^${programmingLanguage}$`,
                $options: "i",
              },
            },
            {
              language: {
                $regex: `^${programmingLanguage}$`,
                $options: "i",
              },
            },
          ],
        },
      ];
    }

    if (status) {
      query.status = status;
    }

    if (tag) {
      query.tags = { $regex: `^${tag}$`, $options: "i" };
    }

    const [rows, total] = await Promise.all([
      PracticeQuestionData.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PracticeQuestionData.countDocuments(query),
    ]);

    sendJson(response, 200, {
      items: rows.map(normalizePracticeQuestionData),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
    return true;
  }

  const questionDataId = getIdFromPath(pathname, "practice-question-data");

  if (request.method === "GET" && questionDataId) {
    const questionData =
      await findPracticeQuestionDataByIdOrSlug(questionDataId);

    if (!questionData) {
      sendJson(response, 404, { message: "Practice question not found." });
      return true;
    }

    sendJson(response, 200, normalizePracticeQuestionData(questionData));
    return true;
  }

  if (request.method === "POST" && pathname === "/api/practice-question-data") {
    const body = await readRequestJson(request);
    const payload = buildProblemPayload(body);
    const validationError = validateProblemPayload(payload);

    if (validationError) {
      sendJson(response, 400, { message: validationError });
      return true;
    }

    if (await findPracticeQuestionDataByIdOrSlug(payload.slug)) {
      sendJson(response, 409, {
        message: "This practice question slug is already used.",
      });
      return true;
    }

    const questionData = await PracticeQuestionData.create(payload);
    sendJson(response, 201, {
      message: "Practice question created.",
      practiceQuestion: normalizePracticeQuestionData(questionData),
    });
    return true;
  }

  if (request.method === "PUT" && questionDataId) {
    const body = await readRequestJson(request);
    const payload = buildProblemPayload(body, { partial: true });
    const validationError = validateProblemPayload(payload, { partial: true });

    if (validationError) {
      sendJson(response, 400, { message: validationError });
      return true;
    }

    if (
      payload.slug &&
      (await findPracticeQuestionDataByIdOrSlug(payload.slug, questionDataId))
    ) {
      sendJson(response, 409, {
        message: "This practice question slug is already used.",
      });
      return true;
    }

    const updatedQuestionData = await PracticeQuestionData.findByIdAndUpdate(
      questionDataId,
      payload,
      {
        new: true,
        runValidators: true,
      },
    );

    if (!updatedQuestionData) {
      sendJson(response, 404, { message: "Practice question not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "Practice question updated.",
      practiceQuestion: normalizePracticeQuestionData(updatedQuestionData),
    });
    return true;
  }

  if (request.method === "DELETE" && questionDataId) {
    const deletedQuestionData =
      await PracticeQuestionData.findByIdAndDelete(questionDataId);

    if (!deletedQuestionData) {
      sendJson(response, 404, { message: "Practice question not found." });
      return true;
    }

    sendJson(response, 200, { message: "Practice question deleted." });
    return true;
  }

  return false;
};

const handleProblemTags = async (request, response, pathname) => {
  if (request.method !== "GET" || pathname !== "/api/problems/tags") {
    return false;
  }

  const rows = await Problem.aggregate([
    { $unwind: "$tags" },
    {
      $group: {
        _id: { $toLower: "$tags" },
        count: { $sum: 1 },
        tag: { $first: "$tags" },
      },
    },
    { $sort: { count: -1, tag: 1 } },
  ]);

  sendJson(response, 200, {
    items: rows.map((row) => ({ tag: row.tag, count: row.count })),
  });
  return true;
};

const handleLanguages = async (request, response, pathname) => {
  if (pathname === "/api/languages/reorder" && request.method === "PUT") {
    const body = await readRequestJson(request);
    const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];

    await Promise.all(
      orderedIds.map((id, index) =>
        Language.findByIdAndUpdate(id, { order: index }),
      ),
    );

    sendJson(response, 200, { message: "Languages reordered." });
    return true;
  }

  if (pathname === "/api/languages" && request.method === "GET") {
    await ensureDefaultLanguages();
    const rows = await Language.find({}).sort({ order: 1, name: 1 }).lean();
    const modules = await Module.find({
      languageId: { $in: rows.map((row) => row._id) },
    })
      .select("_id languageId")
      .lean();
    const moduleLanguageMap = new Map(
      modules.map((moduleDoc) => [
        moduleDoc._id.toString(),
        moduleDoc.languageId.toString(),
      ]),
    );
    const activeCounts = modules.length
      ? await PracticeQuestion.aggregate([
          {
            $match: {
              moduleId: { $in: modules.map((moduleDoc) => moduleDoc._id) },
              status: "active",
            },
          },
          { $group: { _id: "$moduleId", count: { $sum: 1 } } },
        ])
      : [];
    const languageQuestionCounts = new Map();
    activeCounts.forEach((row) => {
      const languageId = moduleLanguageMap.get(row._id.toString());
      if (languageId) {
        languageQuestionCounts.set(
          languageId,
          (languageQuestionCounts.get(languageId) || 0) + row.count,
        );
      }
    });

    sendJson(response, 200, {
      items: rows.map((row) => ({
        ...normalizeLanguage(row),
        activeQuestionCount:
          languageQuestionCounts.get(row._id.toString()) || 0,
      })),
    });
    return true;
  }

  if (pathname === "/api/languages" && request.method === "POST") {
    const body = await readRequestJson(request);
    const name = String(body.name || "").trim();
    const slug = slugify(body.slug || name);
    const icon = String(body.icon || "").trim();

    if (!name) {
      sendJson(response, 400, { message: "name is required." });
      return true;
    }

    const count = await Language.countDocuments();
    const language = await Language.create({
      name,
      slug,
      icon,
      order: count,
    });

    sendJson(response, 201, {
      message: "Language created.",
      language: normalizeLanguage(language),
    });
    return true;
  }

  const languageMatch = pathname.match(/^\/api\/languages\/([^/]+)$/);
  const languageId = languageMatch
    ? decodeURIComponent(languageMatch[1])
    : null;

  if (languageId && request.method === "GET") {
    const language = await Language.findById(languageId).lean();

    if (!language) {
      sendJson(response, 404, { message: "Language not found." });
      return true;
    }

    sendJson(response, 200, normalizeLanguage(language));
    return true;
  }

  if (languageId && request.method === "PUT") {
    const body = await readRequestJson(request);
    const updates = {};

    if ("name" in body) updates.name = String(body.name || "").trim();
    if ("slug" in body) updates.slug = slugify(body.slug);
    if ("icon" in body) updates.icon = String(body.icon || "").trim();
    if ("order" in body) updates.order = Number(body.order) || 0;

    const language = await Language.findByIdAndUpdate(languageId, updates, {
      new: true,
      runValidators: true,
    });

    if (!language) {
      sendJson(response, 404, { message: "Language not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "Language updated.",
      language: normalizeLanguage(language),
    });
    return true;
  }

  if (languageId && request.method === "DELETE") {
    const modules = await Module.find({ languageId }).select("_id").lean();
    const moduleIds = modules.map((row) => row._id);

    await PracticeQuestion.deleteMany({ moduleId: { $in: moduleIds } });
    await Module.deleteMany({ languageId });
    const deleted = await Language.findByIdAndDelete(languageId);

    if (!deleted) {
      sendJson(response, 404, { message: "Language not found." });
      return true;
    }

    sendJson(response, 200, { message: "Language deleted." });
    return true;
  }

  return false;
};

const handleModules = async (request, response, pathname) => {
  if (pathname === "/api/modules/reorder" && request.method === "PUT") {
    const body = await readRequestJson(request);
    const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];

    await Promise.all(
      orderedIds.map((id, index) =>
        Module.findByIdAndUpdate(id, { order: index }),
      ),
    );

    sendJson(response, 200, { message: "Modules reordered." });
    return true;
  }

  const languageModulesMatch = pathname.match(
    /^\/api\/languages\/([^/]+)\/modules$/,
  );

  if (languageModulesMatch && request.method === "GET") {
    const languageId = decodeURIComponent(languageModulesMatch[1]);
    const rows = await Module.find({ languageId })
      .sort({ order: 1, title: 1 })
      .lean();

    const moduleIds = rows.map((row) => row._id);
    const questionCounts = await PracticeQuestion.aggregate([
      { $match: { moduleId: { $in: moduleIds } } },
      { $group: { _id: "$moduleId", count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(
      questionCounts.map((row) => [row._id.toString(), row.count]),
    );

    sendJson(response, 200, {
      items: rows.map((row) => ({
        ...normalizeModule(row),
        questionCount: countMap[row._id.toString()] || 0,
      })),
    });
    return true;
  }

  if (languageModulesMatch && request.method === "POST") {
    const languageId = decodeURIComponent(languageModulesMatch[1]);
    const body = await readRequestJson(request);
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();

    if (!title) {
      sendJson(response, 400, { message: "title is required." });
      return true;
    }

    const language = await Language.findById(languageId);

    if (!language) {
      sendJson(response, 404, { message: "Language not found." });
      return true;
    }

    const count = await Module.countDocuments({ languageId });
    const moduleDoc = await Module.create({
      languageId,
      title,
      description,
      order: count,
    });

    sendJson(response, 201, {
      message: "Module created.",
      module: normalizeModule(moduleDoc),
    });
    return true;
  }

  const moduleMatch = pathname.match(/^\/api\/modules\/([^/]+)$/);
  const moduleId = moduleMatch ? decodeURIComponent(moduleMatch[1]) : null;

  if (moduleId && request.method === "GET") {
    const moduleDoc = await Module.findById(moduleId).lean();

    if (!moduleDoc) {
      sendJson(response, 404, { message: "Module not found." });
      return true;
    }

    sendJson(response, 200, normalizeModule(moduleDoc));
    return true;
  }

  if (moduleId && request.method === "PUT") {
    const body = await readRequestJson(request);
    const updates = {};

    if ("title" in body) updates.title = String(body.title || "").trim();
    if ("description" in body)
      updates.description = String(body.description || "").trim();
    if ("order" in body) updates.order = Number(body.order) || 0;

    const moduleDoc = await Module.findByIdAndUpdate(moduleId, updates, {
      new: true,
      runValidators: true,
    });

    if (!moduleDoc) {
      sendJson(response, 404, { message: "Module not found." });
      return true;
    }

    sendJson(response, 200, {
      message: "Module updated.",
      module: normalizeModule(moduleDoc),
    });
    return true;
  }

  if (moduleId && request.method === "DELETE") {
    await PracticeQuestion.deleteMany({ moduleId });
    const deleted = await Module.findByIdAndDelete(moduleId);

    if (!deleted) {
      sendJson(response, 404, { message: "Module not found." });
      return true;
    }

    sendJson(response, 200, { message: "Module deleted." });
    return true;
  }

  return false;
};

const handlePracticeQuestions = async (request, response, pathname) => {
  const reorderMatch = pathname.match(
    /^\/api\/modules\/([^/]+)\/questions\/reorder$/,
  );

  if (reorderMatch && request.method === "PUT") {
    const moduleId = decodeURIComponent(reorderMatch[1]);
    const body = await readRequestJson(request);
    const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];

    await Promise.all(
      orderedIds.map((id, index) =>
        PracticeQuestion.findByIdAndUpdate(id, { order: index }),
      ),
    );

    sendJson(response, 200, { message: "Questions reordered." });
    return true;
  }

  const moduleQuestionsMatch = pathname.match(
    /^\/api\/modules\/([^/]+)\/questions$/,
  );

  if (moduleQuestionsMatch && request.method === "GET") {
    const moduleId = decodeURIComponent(moduleQuestionsMatch[1]);
    const rows = await PracticeQuestion.find({ moduleId })
      .sort({ order: 1, createdAt: 1 })
      .lean();

    const globalProblemIds = rows
      .filter(
        (row) =>
          row.questionType === "global" || (!row.questionType && row.problemId),
      )
      .map((row) => String(row.problemId || ""))
      .filter(Boolean);
    const practiceQuestionIds = rows
      .filter(
        (row) =>
          row.questionType === "practice" ||
          (!row.questionType && row.questionId),
      )
      .map((row) => String(row.questionId || ""))
      .filter(Boolean);

    const [problems, practiceQuestions] = await Promise.all([
      globalProblemIds.length
        ? Problem.find({ _id: { $in: globalProblemIds } }).lean()
        : Promise.resolve([]),
      practiceQuestionIds.length
        ? PracticeQuestionData.find({
            _id: { $in: practiceQuestionIds },
          }).lean()
        : Promise.resolve([]),
    ]);

    const problemMap = Object.fromEntries(
      problems.map((row) => [row._id.toString(), row]),
    );
    const questionMap = Object.fromEntries(
      practiceQuestions.map((row) => [row._id.toString(), row]),
    );

    const validRows = [];
    const orphanedIds = [];

    for (const row of rows) {
      const questionType =
        row.questionType || (row.questionId ? "practice" : "global");
      const referencedQuestion =
        questionType === "practice"
          ? questionMap[row.questionId?.toString?.() || String(row.questionId)]
          : problemMap[row.problemId?.toString?.() || String(row.problemId)];

      if (referencedQuestion) {
        validRows.push({ row, referencedQuestion });
      } else {
        orphanedIds.push(row._id);
      }
    }

    if (orphanedIds.length) {
      await PracticeQuestion.deleteMany({ _id: { $in: orphanedIds } });
    }

    sendJson(response, 200, {
      items: validRows.map(({ row, referencedQuestion }) =>
        normalizePracticeQuestion(row, referencedQuestion),
      ),
    });
    return true;
  }

  if (moduleQuestionsMatch && request.method === "POST") {
    const moduleId = decodeURIComponent(moduleQuestionsMatch[1]);
    const body = await readRequestJson(request);
    const problemIds = (
      Array.isArray(body.problemIds) ? body.problemIds : [body.problemId]
    )
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .filter((id, index, list) => list.indexOf(id) === index);
    const practiceQuestionIds = (
      Array.isArray(body.practiceQuestionIds)
        ? body.practiceQuestionIds
        : Array.isArray(body.questionIds)
          ? body.questionIds
          : [body.practiceQuestionId || body.questionId]
    )
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .filter((id, index, list) => list.indexOf(id) === index);

    if (!problemIds.length && !practiceQuestionIds.length) {
      sendJson(response, 400, {
        message:
          "problemId/problemIds or practiceQuestionId/practiceQuestionIds is required.",
      });
      return true;
    }

    const moduleDoc = await Module.findById(moduleId);

    if (!moduleDoc) {
      sendJson(response, 404, { message: "Module not found." });
      return true;
    }

    const [problems, practiceQuestions] = await Promise.all([
      problemIds.length
        ? Problem.find({ _id: { $in: problemIds } })
        : Promise.resolve([]),
      practiceQuestionIds.length
        ? PracticeQuestionData.find({ _id: { $in: practiceQuestionIds } })
        : Promise.resolve([]),
    ]);

    const problemMap = Object.fromEntries(
      problems.map((problem) => [problem._id.toString(), problem]),
    );
    const practiceQuestionDataMap = Object.fromEntries(
      practiceQuestions.map((question) => [question._id.toString(), question]),
    );

    const missingProblemIds = problemIds.filter((id) => !problemMap[id]);
    const missingPracticeQuestionIds = practiceQuestionIds.filter(
      (id) => !practiceQuestionDataMap[id],
    );

    if (missingProblemIds.length || missingPracticeQuestionIds.length) {
      sendJson(response, 404, {
        message:
          missingProblemIds.length && missingPracticeQuestionIds.length
            ? "One or more referenced problems or practice questions were not found."
            : missingProblemIds.length
              ? "One or more problems were not found."
              : "One or more practice questions were not found.",
      });
      return true;
    }

    const [existingGlobalRows, existingPracticeRows] = await Promise.all([
      problemIds.length
        ? PracticeQuestion.find({
            moduleId,
            problemId: { $in: problemIds },
          }).lean()
        : Promise.resolve([]),
      practiceQuestionIds.length
        ? PracticeQuestion.find({
            moduleId,
            questionType: "practice",
            questionId: { $in: practiceQuestionIds },
          }).lean()
        : Promise.resolve([]),
    ]);

    const existingProblemIds = new Set(
      existingGlobalRows.map(
        (row) => row.problemId?.toString?.() || String(row.problemId),
      ),
    );
    const existingPracticeIds = new Set(
      existingPracticeRows.map(
        (row) => row.questionId?.toString?.() || String(row.questionId),
      ),
    );

    const newProblemIds = problemIds.filter(
      (id) => !existingProblemIds.has(id),
    );
    const newPracticeQuestionIds = practiceQuestionIds.filter(
      (id) => !existingPracticeIds.has(id),
    );

    if (!newProblemIds.length && !newPracticeQuestionIds.length) {
      sendJson(response, 409, {
        message: "All selected questions are already in the module.",
      });
      return true;
    }

    const count = await PracticeQuestion.countDocuments({ moduleId });
    const status = body.status === "inactive" ? "inactive" : "active";
    let nextOrder = count;
    const createdQuestions = [];

    if (newProblemIds.length) {
      const globalItems = newProblemIds.map((problemId) => ({
        moduleId,
        problemId,
        questionType: "global",
        order: nextOrder++,
        status,
      }));
      createdQuestions.push(
        ...(await PracticeQuestion.insertMany(globalItems)),
      );
    }

    if (newPracticeQuestionIds.length) {
      const practiceItems = newPracticeQuestionIds.map((questionId) => ({
        moduleId,
        questionId,
        questionType: "practice",
        order: nextOrder++,
        status,
      }));
      createdQuestions.push(
        ...(await PracticeQuestion.insertMany(practiceItems)),
      );
    }

    const skippedCount =
      problemIds.length + practiceQuestionIds.length - createdQuestions.length;
    const addMessage = createdQuestions.length
      ? `${createdQuestions.length} question${
          createdQuestions.length === 1 ? "" : "s"
        } added to module.`
      : "No new questions were added.";

    sendJson(response, createdQuestions.length ? 201 : 200, {
      message: skippedCount
        ? `${addMessage} ${skippedCount} skipped.`
        : addMessage,
      skipped: skippedCount,
      items: createdQuestions.map((practiceQuestion) => {
        const questionType =
          practiceQuestion.questionType ||
          (practiceQuestion.questionId ? "practice" : "global");
        const referencedQuestion =
          questionType === "practice"
            ? practiceQuestionDataMap[
                practiceQuestion.questionId?.toString?.() ||
                  String(practiceQuestion.questionId)
              ]
            : problemMap[
                practiceQuestion.problemId?.toString?.() ||
                  String(practiceQuestion.problemId)
              ];
        return normalizePracticeQuestion(practiceQuestion, referencedQuestion);
      }),
      practiceQuestion: createdQuestions[0]
        ? normalizePracticeQuestion(
            createdQuestions[0],
            createdQuestions[0].questionType === "practice"
              ? practiceQuestionDataMap[
                  createdQuestions[0].questionId?.toString?.() ||
                    String(createdQuestions[0].questionId)
                ]
              : problemMap[
                  createdQuestions[0].problemId?.toString?.() ||
                    String(createdQuestions[0].problemId)
                ],
          )
        : null,
    });
    return true;
  }

  const practiceQuestionMatch = pathname.match(
    /^\/api\/practice-questions\/([^/]+)$/,
  );
  const practiceQuestionId = practiceQuestionMatch
    ? decodeURIComponent(practiceQuestionMatch[1])
    : null;

  if (practiceQuestionId && request.method === "PUT") {
    const body = await readRequestJson(request);
    const updates = {};

    if ("status" in body) {
      updates.status = body.status === "inactive" ? "inactive" : "active";
    }

    if ("order" in body) {
      updates.order = Number(body.order) || 0;
    }

    const practiceQuestion = await PracticeQuestion.findByIdAndUpdate(
      practiceQuestionId,
      updates,
      { new: true },
    );

    if (!practiceQuestion) {
      sendJson(response, 404, { message: "Practice question not found." });
      return true;
    }

    const problem = await Problem.findById(practiceQuestion.problemId).lean();

    sendJson(response, 200, {
      message: "Practice question updated.",
      practiceQuestion: normalizePracticeQuestion(practiceQuestion, problem),
    });
    return true;
  }

  if (practiceQuestionId && request.method === "DELETE") {
    const deleted =
      await PracticeQuestion.findByIdAndDelete(practiceQuestionId);

    if (!deleted) {
      sendJson(response, 404, { message: "Practice question not found." });
      return true;
    }

    sendJson(response, 200, { message: "Question removed from module." });
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
      const name =
        typeof body.contestName === "string" ? body.contestName.trim() : "";
      updates.contestName = name || "Weekly Contest";
    }

    if (typeof body.contestQuestionCount === "number") {
      updates.contestQuestionCount = Math.max(
        1,
        Math.min(100, Math.floor(body.contestQuestionCount)),
      );
    }

    if (typeof body.contestDurationSeconds === "number") {
      updates.contestDurationSeconds = Math.max(
        30,
        Math.min(14400, Math.floor(body.contestDurationSeconds)),
      );
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

    if ("quizName" in body) {
      const name =
        typeof body.quizName === "string" ? body.quizName.trim() : "";
      updates.quizName = name || "Practice Quiz";
    }

    if (typeof body.quizQuestionCount === "number") {
      updates.quizQuestionCount = Math.max(
        1,
        Math.min(100, Math.floor(body.quizQuestionCount)),
      );
    }

    if (typeof body.quizDurationSeconds === "number") {
      updates.quizDurationSeconds = Math.max(
        30,
        Math.min(14400, Math.floor(body.quizDurationSeconds)),
      );
    }

    if (Array.isArray(body.selectedQuizQuestionIds)) {
      updates.selectedQuizQuestionIds = body.selectedQuizQuestionIds
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean);
    }

    const settingsDoc = await getContestSettingsDoc();
    Object.assign(settingsDoc, updates);
    await settingsDoc.save();

    sendJson(response, 200, {
      message: "Contest settings updated.",
      settings: normalizeContestSettings(settingsDoc),
    });
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
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    });
    response.end();
    return true;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      dbReadyState: mongoose.connection.readyState,
      mailReady,
      ...(mailLastError ? { mailError: mailLastError } : {}),
    });
    return true;
  }

  try {
    if (await handleCompile(request, response, pathname)) {
      return true;
    }

    await connectDb();

    if (await handleVerifySolution(request, response, pathname)) {
      return true;
    }

    if (await handleSubmitSolution(request, response, pathname)) {
      return true;
    }

    if (await handleUsers(request, response, pathname)) {
      return true;
    }

    if (await handleAuth(request, response, pathname)) {
      return true;
    }

    if (await handleQuestions(request, response, pathname)) {
      return true;
    }

    if (await handleProblemTags(request, response, pathname)) {
      return true;
    }

    if (await handleProblems(request, response, pathname, url)) {
      return true;
    }

    if (await handlePracticeQuestionData(request, response, pathname, url)) {
      return true;
    }

    if (await handleStudentPractice(request, response, pathname)) {
      return true;
    }

    if (await handleLanguages(request, response, pathname)) {
      return true;
    }

    if (await handleModules(request, response, pathname)) {
      return true;
    }

    if (await handlePracticeQuestions(request, response, pathname)) {
      return true;
    }

    if (await handleContestSettings(request, response, pathname)) {
      return true;
    }

    sendJson(response, 404, { message: "API route not found." });
    return true;
  } catch (error) {
    const errorMessage = error?.message || "";
    const duplicateField = error?.keyPattern
      ? Object.keys(error.keyPattern)[0]
      : "";
    const isDuplicateRecord = error?.code === 11000;
    const isInvalidObjectId = error instanceof mongoose.Error.CastError;
    const isValidationError = error instanceof mongoose.Error.ValidationError;
    const isConfigError =
      /MONGODB_URI is missing/i.test(errorMessage) ||
      /URI|connection string|SRV|MongoParseError|Invalid scheme/i.test(
        errorMessage,
      );
    const isDbConnectionError =
      error?.name === "MongooseServerSelectionError" ||
      /Server selection timed out|Could not connect to any servers|ENOTFOUND|ECONNREFUSED|ECONNRESET|timed out|querySrv|SSL|authentication failed|bad auth|IP whitelist|IP allowlist/i.test(
        error?.message || "",
      );
    const isResendError = /Resend API error|Resend is not configured/i.test(
      errorMessage,
    );
    if (
      !isDuplicateRecord &&
      !isInvalidObjectId &&
      !isValidationError &&
      !isConfigError &&
      !isDbConnectionError &&
      !isResendError
    ) {
      console.error("API request failed:", error);
    }

    const statusCode = isDuplicateRecord
      ? 409
      : isInvalidObjectId || isValidationError
        ? 400
        : 500;
    const message = isDuplicateRecord
      ? duplicateField === "slug"
        ? "This problem slug is already used."
        : duplicateField === "email"
          ? "This email is already registered."
          : "A record with this value already exists."
      : isInvalidObjectId
        ? "Invalid record id."
        : isValidationError
          ? Object.values(error.errors || {})
              .map((item) => item.message)
              .filter(Boolean)
              .join(" ") || error.message
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
