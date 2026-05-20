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
  },
  { timestamps: true },
);

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const Question = mongoose.models.Question || mongoose.model("Question", questionSchema);

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
      })
      .then(async () => {
        // Ensure both MongoDB collections exist before first user/admin actions.
        await Promise.all([
          User.createCollection().catch(() => undefined),
          Question.createCollection().catch(() => undefined),
        ]);
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  await connectionPromise;
};
