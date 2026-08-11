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
    blocked: { type: Boolean, default: false },
    stats: { type: Object, default: {} },
    resume: { type: Object, default: {} },
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
    timeLimit: { type: String, default: "1 second" },
    memoryLimit: { type: String, default: "256 MB" },
    explanation: { type: String, default: "" },
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

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Question =
  mongoose.models.Question || mongoose.model("Question", questionSchema);
export const Problem =
  mongoose.models.Problem || mongoose.model("Problem", problemSchema);
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
          Question.createCollection().catch(() => undefined),
          Problem.createCollection().catch(() => undefined),
          ContestSettings.createCollection().catch(() => undefined),
          Language.createCollection().catch(() => undefined),
          Module.createCollection().catch(() => undefined),
          PracticeQuestion.createCollection().catch(() => undefined),
          PracticeQuestionData.createCollection().catch(() => undefined),
        ]);
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  await connectionPromise;
};
