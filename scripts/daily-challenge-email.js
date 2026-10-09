/* eslint-env node */
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { connectDb } from "../server/db.js";
import {
  runDailyChallengeJob,
  sendDailyChallengeTestEmail,
  validateDailyChallengeEmailConfig,
} from "../server/dailyChallengeEmail.js";

dotenv.config();

const run = async () => {
  const args = new Set(process.argv.slice(2));
  const allowedArgs = new Set(["--dry-run", "--run-now", "--send-test"]);
  const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length) {
    throw new Error(`Unknown option(s): ${unknownArgs.join(", ")}.`);
  }
  if (args.has("--dry-run") && args.has("--run-now")) {
    throw new Error("Choose either --dry-run or --run-now, not both.");
  }
  if (args.has("--send-test") && (args.has("--dry-run") || args.has("--run-now"))) {
    throw new Error("--send-test cannot be combined with batch options.");
  }

  if (args.has("--send-test")) {
    const recipient = process.env.DAILY_EMAIL_TEST_RECIPIENT || "";
    validateDailyChallengeEmailConfig();
    const resendEmailId = await sendDailyChallengeTestEmail(recipient);
    console.info("Daily challenge template test accepted by Resend.", {
      resendEmailId,
    });
    return;
  }

  const dryRun =
    args.has("--dry-run") ||
    !args.has("--run-now") ||
    process.env.DAILY_EMAIL_ENABLED !== "true" ||
    process.env.DAILY_EMAIL_DRY_RUN !== "false";
  if (!dryRun && !args.has("--run-now")) {
    throw new Error("A real batch requires the explicit --run-now option.");
  }

  validateDailyChallengeEmailConfig();
  await connectDb();
  const counts = await runDailyChallengeJob({ dryRun });
  console.info(`Daily challenge ${dryRun ? "dry run" : "manual run"} complete.`, counts);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run()
    .catch((error) => {
      console.error("Daily challenge email command failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      const { default: mongoose } = await import("mongoose");
      await mongoose.disconnect();
    });
}
