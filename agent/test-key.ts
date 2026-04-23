import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "node:path";

config({ path: path.resolve("..", ".env") });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 20,
  messages: [{ role: "user", content: "Say 'ok' and nothing else." }],
});

const text = response.content
  .filter((b) => b.type === "text")
  .map((b) => (b as { type: "text"; text: string }).text)
  .join("");

console.log("Response:", text);
console.log("Input tokens:", response.usage.input_tokens);
console.log("Output tokens:", response.usage.output_tokens);
