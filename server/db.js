/* eslint-env node */
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
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
    section: { type: String, enum: ["quiz", "contest", "both"], default: "both" },
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

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);
export const ContestSettings =
  mongoose.models.ContestSettings || mongoose.model("ContestSettings", contestSettingsSchema);

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
          ContestSettings.createCollection().catch(() => undefined),
        ]);
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  await connectionPromise;
};
