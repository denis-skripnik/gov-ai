import fs from "fs";
import "dotenv/config";

const API_URL = "https://api.ambient.xyz/v1/chat/completions";
const API_KEY = process.env.AMBIENT_API_KEY;

if (!API_KEY) {
  throw new Error("Set AMBIENT_API_KEY env variable");
}

export async function analyzeWithLLM(url, extracted, principles) {
  const prompt = buildPrompt(url, extracted, principles);

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You are a governance analysis assistant. You must output ONLY valid JSON." },
        { role: "user", content: prompt }
      ],
      stream: false
    })
  });

  const data = await response.json();

  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("No response from Ambient");
  }

  // Модель обязана вернуть JSON
  let report;
  try {
    report = JSON.parse(text);
  } catch (e) {
    console.error("Model returned non-JSON:");
    console.error(text);
    throw new Error("Invalid JSON from model");
  }

  return report;
}

function buildPrompt(url, extracted, principles) {
  return `
You are given:

URL:
${url}

EXTRACTED_DATA (may be incomplete):
${JSON.stringify(extracted, null, 2)}

USER_PRINCIPLES:
${JSON.stringify(principles, null, 2)}

TASK:
Produce a JSON report with the following rules:

- If some fields (options, results, execution details) are missing or uncertain, you MUST explicitly say "UNKNOWN".
- Do NOT guess voting options or results.
- Base your analysis ONLY on provided data.
- Be conservative and honest.
- Output ONLY valid JSON, no comments, no markdown.

Follow this JSON structure exactly:
${fs.readFileSync("./report.schema.json", "utf-8")}
`;
}
