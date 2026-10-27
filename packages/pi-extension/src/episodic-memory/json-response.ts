import { EPISODIC_MEMORY_TYPES, type EpisodicMemoryCandidate, type EpisodicMemoryType } from "./types";

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1].trim());
    throw new Error("Side-query did not return valid JSON");
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseCandidate(value: unknown): EpisodicMemoryCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const name = nonEmptyString(record.name);
  const description = nonEmptyString(record.description);
  const body = nonEmptyString(record.body);
  const type = record.type;
  if (
    !name ||
    !description ||
    !body ||
    typeof type !== "string" ||
    !(EPISODIC_MEMORY_TYPES as readonly string[]).includes(type)
  ) {
    return undefined;
  }
  return { name, type: type as EpisodicMemoryType, description, body };
}

export function parseSelectedFilenames(text: string): string[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Memory selector must return a JSON string array");
  }
  return parsed.map((item) => item.trim()).filter(Boolean);
}

export function parseMemoryCandidates(text: string): EpisodicMemoryCandidate[] {
  const parsed = parseJson(text);
  if (!Array.isArray(parsed)) throw new Error("Memory extractor must return a JSON array");
  const candidates = parsed.map(parseCandidate);
  if (candidates.some((candidate) => candidate === undefined)) {
    throw new Error("Memory extractor returned an invalid candidate");
  }
  return candidates as EpisodicMemoryCandidate[];
}

export function parseUpdatedMemory(text: string): EpisodicMemoryCandidate | undefined {
  const parsed = parseJson(text);
  if (parsed === null) return undefined;
  const candidate = parseCandidate(parsed);
  if (!candidate) throw new Error("Memory updater returned an invalid memory");
  return candidate;
}
