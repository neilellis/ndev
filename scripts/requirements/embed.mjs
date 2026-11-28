const BATCH = 100;
const EXCERPT = 300;

class Stop extends Error {}
const fail = (message) => {
  throw new Stop(message);
};

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    fail(`embed.mjs reads {model, dimensions, inputs} as JSON on stdin, and got text that is not JSON: ${error.message}`);
  }
  const { model, dimensions, inputs, labels = [] } = request;
  if (typeof model !== "string" || !Number.isInteger(dimensions) || !Array.isArray(inputs) || !inputs.every((text) => typeof text === "string" && text)) fail(`embed.mjs reads {model, dimensions, inputs} on stdin, with inputs a list of non-empty strings. Got: ${JSON.stringify(request).slice(0, EXCERPT)}`);
  const key = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_API_KEY;
  if (!key) fail("OPENROUTER_API_KEY (or OPEN_ROUTER_API_KEY) is not set.");
  const url = `${(process.env.NDEV_EMBEDDINGS_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "")}/embeddings`;

  const vectors = [];
  let tokens = 0;
  let cost = 0;
  for (let start = 0; start < inputs.length; start += BATCH) {
    const batch = inputs.slice(start, start + BATCH);
    const named = [...new Set(labels.slice(start, start + BATCH))].join(", ");
    const which = `inputs ${start + 1} to ${start + batch.length} of ${inputs.length}${named ? ` (${named})` : ""}`;
    let response;
    try {
      response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, dimensions, input: batch }) });
    } catch (error) {
      fail(`POST ${url} for ${which} got no answer: ${error.cause?.message ?? error.message}`);
    }
    let body;
    try {
      body = await response.text();
    } catch (error) {
      fail(`POST ${url} for ${which} answered HTTP ${response.status}, and its body could not be read: ${error.cause?.message ?? error.message}`);
    }
    if (!response.ok) fail(`POST ${url} for ${which} answered HTTP ${response.status}: ${body.slice(0, EXCERPT)}`);
    let answer;
    try {
      answer = JSON.parse(body);
    } catch (error) {
      fail(`POST ${url} for ${which} answered HTTP ${response.status} with a body that is not JSON (${error.message}): ${body.slice(0, EXCERPT)}`);
    }
    const data = Array.isArray(answer?.data) ? [...answer.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : undefined;
    if (!data || data.length !== batch.length || !data.every((item) => Array.isArray(item?.embedding) && item.embedding.length === dimensions && item.embedding.every(Number.isFinite))) fail(`POST ${url} for ${which} answered HTTP ${response.status} without ${batch.length} embeddings of ${dimensions} numbers: ${body.slice(0, EXCERPT)}`);
    vectors.push(...data.map((item) => item.embedding));
    tokens += Number(answer.usage?.prompt_tokens) || 0;
    cost = typeof answer.usage?.cost === "number" && cost !== null ? cost + answer.usage.cost : null;
  }
  process.stdout.write(JSON.stringify({ vectors, tokens, cost }));
}

try {
  await main();
} catch (error) {
  if (!(error instanceof Stop)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
