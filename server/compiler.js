/* eslint-env node */
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

const compileRunOptions = {
  timeout: Number(process.env.COMPILER_RUN_TIMEOUT_MS || 10000),
  compileTimeout: Number(process.env.COMPILER_COMPILE_TIMEOUT_MS || 10000),
  ...(process.env.JAVA_COMPILATION_PATH
    ? { compilationPath: process.env.JAVA_COMPILATION_PATH }
    : {}),
  ...(process.env.JAVA_EXECUTION_PATH
    ? { executionPath: process.env.JAVA_EXECUTION_PATH }
    : {}),
  ...(process.env.PYTHON_EXECUTION_PATH
    ? { executionPath: process.env.PYTHON_EXECUTION_PATH }
    : {}),
  ...(process.env.CPP_COMPILATION_PATH
    ? { compilationPath: process.env.CPP_COMPILATION_PATH }
    : {}),
};

let pistonRuntimesCache = null;
let pistonRuntimesLoadedAt = 0;

const formatLocalOutput = (result) => {
  const output = [result.stdout, result.stderr].filter(Boolean).join("");

  return {
    output: output || "Code ran successfully with no output.",
    code: result.exitCode ?? 0,
    signal: result.signal || null,
    runtime: "local",
    errorType: result.errorType || null,
  };
};

const runWithCompileRun = async ({ language, code, stdin }) => {
  const options = { ...compileRunOptions, stdin };

  let result;

  if (language === "java") {
    result = await java.runSource(code, options);
  } else if (language === "python") {
    result = await python.runSource(code, options);
  } else if (language === "cpp") {
    result = await cpp.runSource(code, options);
  } else {
    throw new Error("Unsupported language.");
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
      (alias) => runtime.language === alias || runtime.aliases?.includes(alias),
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
    code: runOutput.code ?? compileOutput.code ?? 0,
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
    const error = new Error("Supported server languages: python, java, cpp.");
    error.statusCode = 400;
    throw error;
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
    return await runWithCompileRun({
      language: normalizedLanguage,
      code,
      stdin,
    });
  } catch (error) {
    const message = error?.message || "Could not run code locally.";

    if (/ENOENT|not recognized|not found|spawn/i.test(message)) {
      throw new Error(
        `${normalizedLanguage} compiler is not installed or not on PATH. Install the required runtime on the server (JDK for Java, Python for Python, g++ for C++).`,
      );
    }

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

  return { provider: "local", languages: ["python", "java", "cpp"] };
};
