/* eslint-env node */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { handleApiRequest, verifyResendConnection } from "./server/apiHandler.js";
import { verifyCompilerSetup } from "./server/compiler.js";
import { connectDb } from "./server/db.js";
import { handlePageRequest } from "./server/pageHandler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });
const distPath = path.join(__dirname, "..", "CodingFrontend", "dist");
const port = process.env.PORT || 3001;

const server = http.createServer(async (request, response) => {
  const isApiHandled = await handleApiRequest(request, response);

  if (isApiHandled) {
    return;
  }

  handlePageRequest(request, response, distPath);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the old server or change PORT in backend/.env.`);
    return;
  }

  console.error("Server startup error:", error.message);
});

server.listen(port, () => {
  console.log(`Online Quiz running at http://localhost:${port}`);

  connectDb()
    .then(() => {
      console.log("Database connected successfully.");
    })
    .catch((error) => {
      console.error("Database connection error:", error.message);
    });

  verifyResendConnection()
    .then(() => {
      console.log("Resend mail configured successfully.");
    })
    .catch((error) => {
      console.error("Resend mail configuration error:", error.message);
    });

  verifyCompilerSetup()
    .then((setup) => {
      console.log(
        `Code compiler ready (${setup.provider}${setup.url ? `: ${setup.url}` : ""}).`,
      );
    })
    .catch((error) => {
      console.error("Code compiler setup error:", error.message);
    });
});
