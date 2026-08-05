/* eslint-env node */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Problem, connectDb } from "../server/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const migrateProblemLanguage = async () => {
  await connectDb();

  const result = await Problem.collection.updateMany(
    {},
    [
      {
        $set: {
          programmingLanguage: { $ifNull: ["$programmingLanguage", "$language"] },
        },
      },
      {
        $unset: "language",
      },
    ],
  );

  const indexes = await Problem.collection.indexes();
  const textIndexes = indexes.filter((index) =>
    Object.values(index.key || {}).includes("text"),
  );

  for (const index of textIndexes) {
    await Problem.collection.dropIndex(index.name);
  }

  await Problem.collection.createIndex(
    { title: "text", slug: "text", tags: "text" },
    {
      default_language: "none",
      language_override: "mongoTextLanguage",
      name: "title_text_slug_text_tags_text",
    },
  );

  await Problem.collection.createIndex(
    { difficulty: 1, programmingLanguage: 1, createdAt: -1 },
    { name: "difficulty_1_programmingLanguage_1_createdAt_-1" },
  );

  console.log(
    `Migrated ${result.modifiedCount} problem documents to programmingLanguage.`,
  );
};

migrateProblemLanguage()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Problem language migration failed:", error);
    process.exit(1);
  });
