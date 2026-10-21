import test from "node:test";
import assert from "node:assert/strict";
import { completeText } from "../../dist/text/complete.js";

function captureClient(response = { choices: [{ message: { content: "pong" } }] }) {
  const requests = [];
  const client = {
    apiKey: "test-key",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(response);
    },
  };
  return { client, requests };
}

test("completeText defaults to agnes-2.5-flash", async () => {
  const { client, requests } = captureClient();
  const result = await completeText({ prompt: "say pong" }, client);

  assert.equal(result.text, "pong");
  assert.equal(result.model, "agnes-2.5-flash");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "agnes-2.5-flash",
    messages: [{ role: "user", content: "say pong" }],
  });
});

test("completeText accepts newer text models", async () => {
  const { client, requests } = captureClient();
  const result = await completeText({ prompt: "code", model: "agnes-3.0-flash" }, client);

  assert.equal(result.model, "agnes-3.0-flash");
  assert.equal(JSON.parse(requests[0].init.body).model, "agnes-3.0-flash");
});
