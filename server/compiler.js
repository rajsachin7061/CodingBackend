import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const supportedLanguages = new Set(["python", "java", "cpp"]);
const commandCheckTimeoutMs = 3000;
const executionTimeoutMs = 10000;

const runProcess = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const cleanup = () => {
      finished = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    };

    const timeout = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        cleanup();
        reject(new Error("Execution timed out."));
      }
    }, executionTimeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      cleanup();
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      cleanup();

      if (code === 0) {
        resolve({ stdout, stderr, signal });
      } else {
        const message = stderr.trim() || stdout.trim() || `Process exited with code ${code}${signal ? ` signal ${signal}` : ""}`;
        const error = new Error(message);
        error.code = code;
        reject(error);
      }
    });
  });

const tryCommand = async (commands) => {
  for (const command of commands) {
    try {
      await runProcess(command, ["--version"], { cwd: process.cwd() });
      return command;
    } catch {
      continue;
    }
  }
  return null;
};

const getCommandForLanguage = async (language) => {
  if (language === "python") {
    return await tryCommand(["python", "python3", "py"]);
  }

  if (language === "java") {
    return await tryCommand(["javac"]);
  }

  if (language === "cpp") {
    return await tryCommand(["g++", "clang++"]);
  }

  return null;
};

export const isSupportedCompilerLanguage = (language) =>
  supportedLanguages.has(String(language || "").toLowerCase());

export const verifyCompilerSetup = async () => {
  const setup = {
    python: Boolean(await getCommandForLanguage("python")),
    java: Boolean(await getCommandForLanguage("java")),
    cpp: Boolean(await getCommandForLanguage("cpp")),
  };

  return setup;
};

const writeTempFile = async (directory, name, content) => {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
};

export const runCompiledCode = async ({ language, code, stdin = "" }) => {
  const normalizedLanguage = String(language || "").toLowerCase();

  if (!isSupportedCompilerLanguage(normalizedLanguage)) {
    const error = new Error("Unsupported language.");
    error.statusCode = 400;
    throw error;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-runner-"));

  try {
    if (normalizedLanguage === "python") {
      const pythonCmd = await getCommandForLanguage("python");
      if (!pythonCmd) {
        const error = new Error("Python is not installed or not available in PATH.");
        error.statusCode = 500;
        throw error;
      }

      const scriptPath = await writeTempFile(tempDir, "Main.py", code);
      const result = await runProcess(pythonCmd, [scriptPath], {
        cwd: tempDir,
        input: stdin,
      });

      return {
        output: result.stdout.trim(),
        runtime: `Python`,
      };
    }

    if (normalizedLanguage === "java") {
      const javaCompiler = await getCommandForLanguage("java");
      if (!javaCompiler) {
        const error = new Error("Java compiler is not installed or not available in PATH.");
        error.statusCode = 500;
        throw error;
      }

      const sourcePath = await writeTempFile(tempDir, "Main.java", code);
      await runProcess(javaCompiler, [sourcePath], { cwd: tempDir });

      const result = await runProcess("java", ["-cp", tempDir, "Main"], {
        cwd: tempDir,
        input: stdin,
      });

      return {
        output: result.stdout.trim(),
        runtime: `Java`,
      };
    }

    if (normalizedLanguage === "cpp") {
      const cppCompiler = await getCommandForLanguage("cpp");
      if (!cppCompiler) {
        const error = new Error("C++ compiler is not installed or not available in PATH.");
        error.statusCode = 500;
        throw error;
      }

      const sourcePath = await writeTempFile(tempDir, "main.cpp", code);
      const executableName = process.platform === "win32" ? "main.exe" : "main";
      const executablePath = path.join(tempDir, executableName);
      await runProcess(cppCompiler, [sourcePath, "-std=c++17", "-O2", "-o", executablePath], {
        cwd: tempDir,
      });

      const result = await runProcess(executablePath, [], {
        cwd: tempDir,
        input: stdin,
      });

      return {
        output: result.stdout.trim(),
        runtime: `C++`,
      };
    }

    const error = new Error("Unsupported language.");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 400;
    }
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
};
