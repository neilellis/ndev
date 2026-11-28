import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [rulesFile, logFile] = process.argv.slice(2);
const rules = Object.entries(JSON.parse(readFileSync(rulesFile, "utf8")));
const DIMENSIONS = 512;

function vector(text) {
  const v = new Array(DIMENSIONS).fill(0);
  const lower = text.toLowerCase();
  const hit = rules.filter(([part]) => lower.includes(part.toLowerCase()));
  for (const [, axis] of hit) v[axis] += 1;
  const spare = 100 + (createHash("sha256").update(text).digest().readUInt32BE(0) % (DIMENSIONS - 100));
  v[spare] += hit.length ? 0.1 : 1;
  return v;
}

const answer = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const [, tag, ...rest] = request.url.split("/");
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return answer(response, 400, { error: { message: "body is not JSON" } });
    }
    appendFileSync(logFile, `${JSON.stringify({ tag, path: `/${rest.join("/")}`, authorized: Boolean(request.headers.authorization), model: body.model, dimensions: body.dimensions, input: body.input })}\n`);
    if (request.method !== "POST" || rest.join("/") !== "v1/embeddings") return answer(response, 404, { error: { message: `no route ${request.method} ${request.url}` } });
    if (request.headers.authorization !== "Bearer test-key") return answer(response, 400, { error: { message: "missing or wrong Authorization header" } });
    if (body.model !== "openai/text-embedding-3-small") return answer(response, 400, { error: { message: `unknown model ${body.model}` } });
    if (body.dimensions !== DIMENSIONS) return answer(response, 400, { error: { message: `dimensions must be ${DIMENSIONS}` } });
    if (tag === "fail500") return answer(response, 500, { error: { message: "the fake embeddings service failed on purpose" } });
    if (tag === "reset") {
      response.writeHead(200, { "content-type": "application/json", "content-length": "100000" });
      return response.write('{"data":[', () => setTimeout(() => request.socket.destroy(), 50));
    }
    const tokens = body.input.reduce((sum, text) => sum + text.split(/\s+/).length, 0);
    answer(response, 200, { data: body.input.map((text, index) => ({ index, embedding: vector(text) })), usage: { prompt_tokens: tokens, cost: tokens / 1e6 } });
  });
});

server.listen(0, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
