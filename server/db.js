/* eslint-env node */
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    username: { type: String, trim: true, default: "" },
    password: { type: String, required: true },
    photo: { type: String, default: "" },
    dailyChallengeEmailOptIn: { type: Boolean, default: false },
    blocked: { type: Boolean, default: false },
    stats: { type: Object, default: {} },
    resume: { type: Object, default: {} },
  },
  { timestamps: true },
);

const authSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    role: { type: String, enum: ["user", "admin"], required: true },
    adminUsername: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const premiumPlanSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 100 },
    currency: { type: String, default: "INR", enum: ["INR"] },
    modules: {
      type: [{ type: String, enum: ["DSA", "PRACTICE"] }],
      required: true,
    },
    features: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const paymentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    planCode: { type: String, required: true, uppercase: true },
    modulesToGrant: {
      type: [{ type: String, enum: ["DSA", "PRACTICE"] }],
      required: true,
    },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, enum: ["INR"] },
    provider: { type: String, default: "razorpay", enum: ["razorpay"] },
    orderId: { type: String, required: true, unique: true },
    paymentId: { type: String, default: undefined, sparse: true, unique: true },
    status: {
      type: String,
      enum: [
        "created",
        "authorized",
        "captured",
        "failed",
        "cancelled",
        "refund_pending",
        "refunded",
      ],
      default: "created",
      required: true,
    },
    paidAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    failureReason: { type: String, default: "" },
    receipt: { type: String, required: true, unique: true },
  },
  { timestamps: true },
);
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ userId: 1, status: 1, modulesToGrant: 1 });

const entitlementSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    module: { type: String, enum: ["DSA", "PRACTICE"], required: true },
    purchaseId: { type: String, required: true },
    paymentId: { type: String, required: true },
    purchaseAmount: { type: Number, required: true, min: 1 },
    purchaseDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "inactive", "refunded"],
      default: "active",
      required: true,
    },
    expiresAt: { type: Date, default: null },
    provider: { type: String, default: "razorpay", enum: ["razorpay"] },
  },
  { timestamps: true },
);
entitlementSchema.index({ userId: 1, module: 1 }, { unique: true });
entitlementSchema.index({ status: 1, expiresAt: 1 });

const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true },
    processed: { type: Boolean, default: false },
    processedAt: { type: Date, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

const questionSchema = new mongoose.Schema(
  {
    category: { type: String, required: true, trim: true },
    question: { type: String, required: true, trim: true },
    options: { type: [String], required: true },
    answer: { type: String, required: true, trim: true },
    section: {
      type: String,
      enum: ["quiz", "contest", "both"],
      default: "both",
    },
  },
  { timestamps: true },
);

const contestSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    contestName: { type: String, trim: true, default: "Weekly Contest" },
    contestQuestionCount: { type: Number, default: 10, min: 1, max: 100 },
    contestDurationSeconds: { type: Number, default: 600, min: 30, max: 14400 },
    isScheduled: { type: Boolean, default: false },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    selectedQuestionIds: { type: [String], default: [] },
    showLeaderboardToUsers: { type: Boolean, default: false },
    quizName: { type: String, trim: true, default: "Practice Quiz" },
    quizQuestionCount: { type: Number, default: 10, min: 1, max: 100 },
    quizDurationSeconds: { type: Number, default: 600, min: 30, max: 14400 },
    selectedQuizQuestionIds: { type: [String], default: [] },
  },
  { timestamps: true },
);

const testCaseSchema = new mongoose.Schema(
  {
    input: { type: String, default: "" },
    output: { type: String, default: "" },
    explanation: { type: String, default: "" },
  },
  { _id: false },
);

const starterCodeSchema = new mongoose.Schema(
  {
    java: { type: String, default: "" },
    cpp: { type: String, default: "" },
    python: { type: String, default: "" },
    javascript: { type: String, default: "" },
  },
  { _id: false },
);

const problemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    difficulty: {
      type: String,
      enum: ["Easy", "Medium", "Hard"],
      required: true,
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "published",
    },
    programmingLanguage: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    notes: { type: String, default: "" },
    inputFormat: { type: String, default: "" },
    outputFormat: { type: String, default: "" },
    constraints: { type: String, default: "" },
    sampleTestCases: { type: [testCaseSchema], default: [] },
    hiddenTestCases: { type: [testCaseSchema], default: [] },
    starterCode: { type: starterCodeSchema, default: () => ({}) },
    starterCodeTemplate: { type: String, default: "" },
    solution: { type: String, default: "" },
    tags: { type: [String], default: [] },
    premiumModule: {
      type: String,
      enum: ["", "DSA", "PRACTICE"],
      default: "",
      index: true,
    },
    timeLimit: { type: String, default: "1 second" },
    memoryLimit: { type: String, default: "256 MB" },
    explanation: { type: String, default: "" },
  },
  { timestamps: true },
);

const problemSheetSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    problemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Problem" }],
  },
  { timestamps: true },
);

problemSchema.index(
  { title: "text", slug: "text", tags: "text" },
  { default_language: "none", language_override: "mongoTextLanguage" },
);
problemSchema.index({ difficulty: 1, status: 1, createdAt: -1 });

const practiceQuestionDataSchema = new mongoose.Schema(problemSchema.obj, {
  timestamps: true,
});

practiceQuestionDataSchema.index(
  { title: "text", slug: "text", tags: "text" },
  { default_language: "none", language_override: "mongoTextLanguage" },
);
practiceQuestionDataSchema.index({ difficulty: 1, status: 1, createdAt: -1 });

const languageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    slug: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    icon: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const moduleSchema = new mongoose.Schema(
  {
    languageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Language",
      required: true,
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

moduleSchema.index({ languageId: 1, order: 1 });

const practiceQuestionSchema = new mongoose.Schema(
  {
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Module",
      required: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    questionType: {
      type: String,
      enum: ["global", "practice"],
      default: "global",
    },
    problemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Problem",
    },
    order: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  { timestamps: true },
);

practiceQuestionSchema.index({ moduleId: 1, order: 1 });
practiceQuestionSchema.index(
  { moduleId: 1, questionType: 1, questionId: 1 },
  { unique: true, partialFilterExpression: { questionId: { $exists: true } } },
);
practiceQuestionSchema.index(
  { moduleId: 1, problemId: 1 },
  { unique: true, sparse: true },
);

const submissionSchema = new mongoose.Schema(
  {
    problemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Problem",
      required: true,
    },
    problemSlug: { type: String, trim: true, default: "" },
    userEmail: { type: String, trim: true, lowercase: true, default: "" },
    username: { type: String, trim: true, default: "" },
    language: { type: String, required: true, trim: true },
    code: { type: String, default: "" },
    status: {
      type: String,
      enum: ["Accepted", "Failed"],
      default: "Accepted",
    },
    passedCount: { type: Number, default: 0, min: 0 },
    totalCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

submissionSchema.index({ problemId: 1, userEmail: 1, createdAt: -1 });

const dailyEmailTrackingSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recipientEmail: { type: String, default: "", lowercase: true, trim: true },
    emailType: { type: String, required: true, default: "daily_challenge" },
    scheduledDate: { type: String, required: true },
    resendEmailId: { type: String, default: "" },
    status: {
      type: String,
      enum: ["sending", "accepted", "delivered", "failed", "uncertain", "skipped"],
      required: true,
    },
    errorDetails: { type: String, default: "" },
    attemptedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

dailyEmailTrackingSchema.index(
  { userId: 1, emailType: 1, scheduledDate: 1 },
  { unique: true },
);

const dailyEmailJobLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    leaseUntil: { type: Date, required: true },
    status: {
      type: String,
      enum: ["running", "completed"],
      default: "running",
    },
  },
  { timestamps: true, versionKey: false },
);

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const AuthSession =
  mongoose.models.AuthSession || mongoose.model("AuthSession", authSessionSchema);
export const PremiumPlan =
  mongoose.models.PremiumPlan || mongoose.model("PremiumPlan", premiumPlanSchema);
export const Payment =
  mongoose.models.Payment || mongoose.model("Payment", paymentSchema);
export const Entitlement =
  mongoose.models.Entitlement ||
  mongoose.model("Entitlement", entitlementSchema);
export const WebhookEvent =
  mongoose.models.WebhookEvent ||
  mongoose.model("WebhookEvent", webhookEventSchema);
export const DailyEmailTracking =
  mongoose.models.DailyEmailTracking ||
  mongoose.model("DailyEmailTracking", dailyEmailTrackingSchema);
export const DailyEmailJobLock =
  mongoose.models.DailyEmailJobLock ||
  mongoose.model("DailyEmailJobLock", dailyEmailJobLockSchema);
export const Question =
  mongoose.models.Question || mongoose.model("Question", questionSchema);
export const Problem =
  mongoose.models.Problem || mongoose.model("Problem", problemSchema);
export const ProblemSheet =
  mongoose.models.ProblemSheet ||
  mongoose.model("ProblemSheet", problemSheetSchema);
export const PracticeQuestionData =
  mongoose.models.PracticeQuestionData ||
  mongoose.model("PracticeQuestionData", practiceQuestionDataSchema);
export const ContestSettings =
  mongoose.models.ContestSettings ||
  mongoose.model("ContestSettings", contestSettingsSchema);
export const Submission =
  mongoose.models.Submission || mongoose.model("Submission", submissionSchema);
export const Language =
  mongoose.models.Language || mongoose.model("Language", languageSchema);
export const Module =
  mongoose.models.Module || mongoose.model("Module", moduleSchema);
export const PracticeQuestion =
  mongoose.models.PracticeQuestion ||
  mongoose.model("PracticeQuestion", practiceQuestionSchema);

let connectionPromise;

export const connectDb = async () => {
  const mongoUri = process.env.MONGODB_URI || "";
  const dbName = process.env.MONGODB_DB_NAME || "online_quiz";

  if (!mongoUri.trim()) {
    throw new Error("MONGODB_URI is missing. Add it to your .env file.");
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(mongoUri, {
        dbName,
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 15000,
      })
      .then(async () => {
        // Ensure both MongoDB collections exist before first user/admin actions.
        await Promise.all([
          User.createCollection().catch(() => undefined),
          AuthSession.createCollection().catch(() => undefined),
          PremiumPlan.createCollection().catch(() => undefined),
          Payment.createCollection().catch(() => undefined),
          Entitlement.createCollection().catch(() => undefined),
          WebhookEvent.createCollection().catch(() => undefined),
          DailyEmailTracking.createCollection().catch(() => undefined),
          DailyEmailJobLock.createCollection().catch(() => undefined),
          Question.createCollection().catch(() => undefined),
          Problem.createCollection().catch(() => undefined),
          ProblemSheet.createCollection().catch(() => undefined),
          ContestSettings.createCollection().catch(() => undefined),
          Language.createCollection().catch(() => undefined),
          Module.createCollection().catch(() => undefined),
          PracticeQuestion.createCollection().catch(() => undefined),
          PracticeQuestionData.createCollection().catch(() => undefined),
        ]);
        await DailyEmailTracking.createIndexes();
        await Promise.all([
          AuthSession.createIndexes(),
          PremiumPlan.createIndexes(),
          Payment.createIndexes(),
          Entitlement.createIndexes(),
          WebhookEvent.createIndexes(),
        ]);
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  await connectionPromise;
};
