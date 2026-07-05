/* eslint-env node */
import { spawn } from "node:child_process";
import compileRun from "compile-run";

const { java, python, cpp } = compileRun;

const compilerProvider = (process.env.COMPILER_PROVIDER || "local")
  .trim()
  .toLowerCase();
const pistonApiUrl = (process.env.PISTON_API_URL || "").replace(/\/+$/, "");

const supportedLanguages = new Set(["python", "java", "cpp"]);

const pistonRuntimeAliases = {
  cpp: ["c++", "cpp"],
  java: ["java"],
  python: ["python", "python3"],
};

const baseCompileRunOptions = {
  timeout: Number(process.env.COMPILER_RUN_TIMEOUT_MS || 10000),
  compileTimeout: Number(process.env.COMPILER_COMPILE_TIMEOUT_MS || 10000),
};

let pistonRuntimesCache = null;
let pistonRuntimesLoadedAt = 0;
const localToolchainCache = new Map();

const logCompiler = (level, message, details = {}) => {
  const log = console[level] || console.log;
  log(`[compiler] ${message}`, details);
};

const createCompilerError = (message, statusCode = 500, details = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
};

const defaultPythonCommand = process.platform === "win32" ? "python" : "python3";

const getLocalToolchain = (language) => {
  const toolchains = {
    java: {
      options: {
        ...baseCompileRunOptions,
        compilationPath: process.env.JAVA_COMPILATION_PATH || "javac",
        executionPath: process.env.JAVA_EXECUTION_PATH || "java",
      },
      required: [
        {
          name: "Java compiler",
          command: process.env.JAVA_COMPILATION_PATH || "javac",
          installHint:
            "Install a Java JDK and make sure javac is on PATH. On Render, deploy this backend with the Dockerfile so OpenJDK is installed.",
        },
        {
          name: "Java runtime",
          command: process.env.JAVA_EXECUTION_PATH || "java",
          installHint:
            "Install a Java JDK/JRE and make sure java is on PATH. On Render, deploy this backend with the Dockerfile so OpenJDK is installed.",
        },
      ],
    },
    python: {
      options: {
        ...baseCompileRunOptions,
        executionPath: process.env.PYTHON_EXECUTION_PATH || defaultPythonCommand,
      },
      required: [
        {
          name: "Python runtime",
          command: process.env.PYTHON_EXECUTION_PATH || defaultPythonCommand,
          installHint:
            "Install Python 3 and make sure python3/python is on PATH.",
        },
      ],
    },
    cpp: {
      options: {
        ...baseCompileRunOptions,
        compilationPath: process.env.CPP_COMPILATION_PATH || "g++",
      },
      required: [
        {
          name: "C++ compiler",
          command: process.env.CPP_COMPILATION_PATH || "g++",
          installHint: "Install g++ and make sure it is on PATH.",
        },
      ],
    },
  };

  return toolchains[language];
};

const checkCommandExists = (command) =>
  new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });

    let settled = false;
    const finish = (isAvailable, error = null) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ command, isAvailable, error });
    };

    child.once("error", (error) => finish(false, error));
    child.once("close", () => finish(true));
  });

const verifyLocalToolchain = async (language) => {
  const toolchain = getLocalToolchain(language);

  if (!toolchain) {
    throw createCompilerError("Unsupported language.", 400);
  }

  const cacheKey = JSON.stringify(toolchain.required.map((tool) => tool.command));
  const cached = localToolchainCache.get(cacheKey);

  if (cached) {
    if (cached.ok) {
      return toolchain;
    }

    throw cached.error;
  }

  for (const tool of toolchain.required) {
    const check = await checkCommandExists(tool.command);

    if (!check.isAvailable) {
      const message = `${tool.name} command "${tool.command}" was not found. ${tool.installHint}`;
      const error = createCompilerError(message, 503, {
        code: check.error?.code || "MISSING_TOOLCHAIN",
        tool: tool.command,
      });

      logCompiler("error", "missing local compiler tool", {
        language,
        command: tool.command,
        errorCode: check.error?.code || null,
        path: process.env.PATH || "",
      });

      localToolchainCache.set(cacheKey, { ok: false, error });
      throw error;
    }
  }

  localToolchainCache.set(cacheKey, { ok: true });
  return toolchain;
};

const formatLocalOutput = (result) => {
  const output = [result.stdout, result.stderr].filter(Boolean).join("");
  const isTimeout = Boolean(result.signal);
  const errorType = isTimeout ? "timeout" : result.errorType || null;

  return {
    output: output || "Code ran successfully with no output.",
    code: result.exitCode != null ? result.exitCode : 0,
    signal: result.signal || null,
    runtime: "local",
    errorType,
    ...(errorType === "compile-time" ? { message: "Compilation failed." } : {}),
    ...(errorType === "run-time" ? { message: "Runtime error." } : {}),
    ...(errorType === "timeout" ? { message: "Execution timed out." } : {}),
  };
};

const runWithCompileRun = async ({ language, code, stdin }) => {
  const toolchain = await verifyLocalToolchain(language);
  const options = { ...toolchain.options, stdin };

  let result;

  if (language === "java") {
    result = await java.runSource(code, options);
  } else if (language === "python") {
    result = await python.runSource(code, options);
  } else if (language === "cpp") {
    result = await cpp.runSource(code, options);
  } else {
    throw createCompilerError("Unsupported language.", 400);
  }

  return formatLocalOutput(result);
};

const getPistonRuntimes = async () => {
  const cacheAgeMs = Date.now() - pistonRuntimesLoadedAt;

  if (pistonRuntimesCache && cacheAgeMs < 30 * 60 * 1000) {
    return pistonRuntimesCache;
  }

  const response = await fetch(`${pistonApiUrl}/runtimes`);

  if (!response.ok) {
    throw new Error("Compiler service runtimes could not be loaded.");
  }

  pistonRuntimesCache = await response.json();
  pistonRuntimesLoadedAt = Date.now();
  return pistonRuntimesCache;
};

const resolvePistonRuntime = async (language) => {
  const aliases = pistonRuntimeAliases[language] || [];
  const runtimes = await getPistonRuntimes();

  return runtimes.find((runtime) =>
    aliases.some(
      (alias) =>
        runtime.language === alias ||
        (runtime.aliases && runtime.aliases.includes(alias)),
    ),
  );
};

const runWithPiston = async ({ language, code, stdin }) => {
  const runtime = await resolvePistonRuntime(language);

  if (!runtime) {
    throw new Error(`${language} runtime is not available right now.`);
  }

  const response = await fetch(`${pistonApiUrl}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: runtime.language,
      version: runtime.version,
      files: [{ content: code }],
      stdin,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.message || "Compiler service could not run this code.",
    );
    error.statusCode = response.status;
    throw error;
  }

  const runOutput = payload.run || {};
  const compileOutput = payload.compile || {};
  const output = [
    compileOutput.stdout,
    compileOutput.stderr,
    runOutput.stdout,
    runOutput.stderr,
  ]
    .filter(Boolean)
    .join("");

  return {
    output: output || "Code ran successfully with no output.",
    code:
      runOutput.code != null
        ? runOutput.code
        : compileOutput.code != null
          ? compileOutput.code
          : 0,
    signal: runOutput.signal || compileOutput.signal || null,
    runtime: `${runtime.language} ${runtime.version}`,
  };
};

const isPistonWhitelistError = (message = "") =>
  /whitelist only|authorization|not freely available/i.test(message);

export const isSupportedCompilerLanguage = (language) =>
  supportedLanguages.has(language);

export const getCompilerProvider = () => {
  if (compilerProvider === "piston" && pistonApiUrl) {
    return "piston";
  }

  return "local";
};

export const runCompiledCode = async ({ language, code, stdin }) => {
  const normalizedLanguage = String(language || "")
    .trim()
    .toLowerCase();

  if (!isSupportedCompilerLanguage(normalizedLanguage)) {
    throw createCompilerError("Supported server languages: python, java, cpp.", 400);
  }

  if (getCompilerProvider() === "piston") {
    try {
      return await runWithPiston({
        language: normalizedLanguage,
        code,
        stdin,
      });
    } catch (error) {
      if (
        isPistonWhitelistError(error.message) &&
        pistonApiUrl.includes("emkc.org")
      ) {
        throw new Error(
          "Public Piston API is whitelist-only. Set COMPILER_PROVIDER=local in backend/.env or host your own Piston instance.",
        );
      }

      throw error;
    }
  }

  try {
    logCompiler("log", "running local code", {
      language: normalizedLanguage,
      codeLength: code.length,
      stdinLength: stdin.length,
    });

    const result = await runWithCompileRun({
      language: normalizedLanguage,
      code,
      stdin,
    });

    logCompiler("log", "local code finished", {
      language: normalizedLanguage,
      code: result.code,
      signal: result.signal,
      errorType: result.errorType,
    });

    return result;
  } catch (error) {
    const message =
      error && error.message ? error.message : "Could not run code locally.";

    if (error?.statusCode) {
      throw error;
    }

    if (/ENOENT|not recognized|not found|spawn/i.test(message)) {
      throw createCompilerError(
        `${normalizedLanguage} compiler is not installed or not on PATH. Install the required runtime on the server (JDK for Java, Python for Python, g++ for C++).`,
        503,
      );
    }

    logCompiler("error", "local compiler failed", {
      language: normalizedLanguage,
      message,
      code: error?.code || null,
      statusCode: error?.statusCode || null,
    });

    throw error;
  }
};

export const verifyCompilerSetup = async () => {
  if (getCompilerProvider() === "piston") {
    if (!pistonApiUrl) {
      throw new Error(
        "PISTON_API_URL is required when COMPILER_PROVIDER=piston.",
      );
    }

    if (pistonApiUrl.includes("emkc.org")) {
      console.warn(
        "Warning: Public Piston API may reject requests. Prefer COMPILER_PROVIDER=local or a self-hosted Piston URL.",
      );
    }

    await getPistonRuntimes();
    return { provider: "piston", url: pistonApiUrl };
  }

  const checks = {};

  for (const language of supportedLanguages) {
    try {
      const toolchain = await verifyLocalToolchain(language);
      checks[language] = {
        ok: true,
        commands: toolchain.required.map((tool) => tool.command),
      };
    } catch (error) {
      checks[language] = {
        ok: false,
        message: error.message,
        tool: error.tool || null,
      };
    }
  }

  const missingLanguages = Object.entries(checks)
    .filter(([, check]) => !check.ok)
    .map(([language]) => language);

  if (missingLanguages.length) {
    logCompiler("error", "local compiler setup incomplete", checks);
  }

  return { provider: "local", languages: ["python", "java", "cpp"], checks };
};
