/* eslint-env node */
import fs from "node:fs";
import path from "node:path";

export const pageUrls = [
  "/",
  "/login",
  "/register",
  "/reset-password",
  "/quiz",
  "/profile",
  "/profile/edit",
  "/profile/certificate",
  "/profile/resume",
  "/logout",
  "/admin",
];

const quizCategoryUrlPattern = /^\/quiz\/(java|c-plus-plus|html|css|javascript)$/;

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const sendFile = (response, filePath) => {
  const extension = path.extname(filePath);
  const contentType = contentTypes[extension] || "application/octet-stream";

  fs.createReadStream(filePath)
    .on("open", () => {
      response.writeHead(200, { "Content-Type": contentType });
    })
    .on("error", () => {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("File not found");
    })
    .pipe(response);
};

export const handlePageRequest = (request, response, distPath) => {
  const url = new URL(request.url, "http://localhost");
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const assetPath = path.join(distPath, safePath);
  const indexPath = path.join(distPath, "index.html");

  if (safePath.startsWith("..")) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("Bad request");
    return;
  }

  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    sendFile(response, assetPath);
    return;
  }

  if (
    (pageUrls.includes(url.pathname) || quizCategoryUrlPattern.test(url.pathname)) &&
    fs.existsSync(indexPath)
  ) {
    sendFile(response, indexPath);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Page not found");
};
