import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFromEnv, contextFromRequest } from "./context.js";

test("contextFromEnv reads the TEMPLATED_* variables", () => {
  const ctx = contextFromEnv({
    TEMPLATED_API_KEY: "key-env",
    TEMPLATED_FOLDER_ID: "fold-1",
    TEMPLATED_EXTERNAL_ID: "cust-1",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(ctx, { apiKey: "key-env", folderId: "fold-1", externalId: "cust-1" });
});

test("contextFromEnv defaults to empty key and null scoping", () => {
  const ctx = contextFromEnv({} as NodeJS.ProcessEnv);
  assert.deepEqual(ctx, { apiKey: "", folderId: null, externalId: null });
});

test("contextFromRequest reads scoping from the query string", () => {
  const url = new URL("https://mcp.templated.io/mcp?folderId=f9&externalId=e7");
  assert.deepEqual(contextFromRequest(url, "key-req"), { apiKey: "key-req", folderId: "f9", externalId: "e7" });
});

test("contextFromRequest leaves scoping null when absent", () => {
  const url = new URL("https://mcp.templated.io/mcp");
  assert.deepEqual(contextFromRequest(url, "k"), { apiKey: "k", folderId: null, externalId: null });
});
