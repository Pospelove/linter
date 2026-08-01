// The module format deliberately keeps test definitions separate from the runner.
// A test describes its input project and CLI contract; the runner owns process
// isolation, Git setup, output normalization, and failure reporting.

const ensureString = (value, label) => {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
};

const fixtureContent = (content) => {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new TypeError("Fixture content must be a string or JSON object");
  }
  // Objects are a convenience for handwritten JSON configuration. Strings
  // remain available for source files and tests that require exact bytes.
  return JSON.stringify(content, null, 2) + "\n";
};

const ensureRelativePath = (filePath) => {
  // Normalize first so Windows separators cannot bypass the parent-directory check.
  const value = ensureString(filePath, "Fixture path").replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.includes("../") || value === "..") {
    throw new Error(`Fixture path must stay inside the temporary project: ${filePath}`);
  }
  return value;
};

export const defineIntegrationTest = (name, define) => {
  ensureString(name, "Test name");
  if (typeof define !== "function") throw new TypeError("Test definition must be a function");

  const files = new Map();
  let args = ["--lint", "--mode", "manual"];
  let expectedStdout = "";
  let expectedStderr = "";
  let expectedExitCode = 0;
  const expectedFiles = new Map();

  const test = {
    addFixtureFile(filePath, content) {
      files.set(ensureRelativePath(filePath), fixtureContent(content));
      return test;
    },
    setArgs(...nextArgs) {
      args = nextArgs.map((arg) => ensureString(arg, "Argument"));
      return test;
    },
    expectStdout(content) {
      expectedStdout = ensureString(content, "Expected stdout");
      return test;
    },
    expectStderr(content) {
      expectedStderr = ensureString(content, "Expected stderr");
      return test;
    },
    expectExitCode(code) {
      if (!Number.isInteger(code)) throw new TypeError("Expected exit code must be an integer");
      expectedExitCode = code;
      return test;
    },
    expectGeneratedFile(filePath, content) {
      expectedFiles.set(ensureRelativePath(filePath), ensureString(content, "Expected file content"));
      return test;
    },
  };

  define(test);
  return { name, files, args, expectedStdout, expectedStderr, expectedExitCode, expectedFiles };
};
