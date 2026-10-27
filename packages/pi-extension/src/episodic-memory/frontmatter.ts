import { parse, stringify } from "yaml";
import { EPISODIC_MEMORY_TYPES, type EpisodicMemoryCandidate, type EpisodicMemoryType } from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

function isMemoryType(value: unknown): value is EpisodicMemoryType {
  return typeof value === "string" && (EPISODIC_MEMORY_TYPES as readonly string[]).includes(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Episodic memory frontmatter requires a non-empty ${key}`);
  }
  return value.trim();
}

export function parseMemoryMarkdown(markdown: string): EpisodicMemoryCandidate {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) throw new Error("Episodic memory must contain YAML frontmatter");

  const parsed = parse(match[1]) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Episodic memory frontmatter must be an object");
  }

  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (!isMemoryType(type)) {
    throw new Error(`Episodic memory type must be one of: ${EPISODIC_MEMORY_TYPES.join(", ")}`);
  }

  const body = match[2].trim();
  if (!body) throw new Error("Episodic memory body must not be empty");

  return {
    name: requiredString(record, "name"),
    type,
    description: requiredString(record, "description"),
    body,
  };
}

export function serializeMemoryMarkdown(memory: EpisodicMemoryCandidate): string {
  const metadata = stringify(
    { name: memory.name.trim(), type: memory.type, description: memory.description.trim() },
    { lineWidth: 0 },
  ).trimEnd();
  return `---\n${metadata}\n---\n\n${memory.body.trim()}\n`;
}
