import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, User } from "./server/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const main = async () => {
  await connectDb();
  const users = await User.find({}).lean();
  console.log("COUNT", users.length);
  console.log(
    "USERS",
    users.map((u) => ({
      email: u.email,
      name: u.name,
      password: u.password?.slice(0, 4),
    })),
  );
};

main().catch((err) => {
  console.error("ERR", err);
  process.exitCode = 1;
});
