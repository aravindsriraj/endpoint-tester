import type { EndpointDefinition, ParameterDef } from "../types";

/**
 * Generates a minimal valid request body from the endpoint's body schema.
 * Only required fields are included. Uses type-aware defaults for common patterns.
 */
export function buildDefaultBody(
  bodySchema: EndpointDefinition["parameters"]["body"],
  endpointSlug: string
): Record<string, unknown> | null {
  if (!bodySchema || !bodySchema.fields.length) return null;

  const requiredFields = bodySchema.fields.filter((f) => f.required);
  // If no required fields, include the first two optional ones to have something to send
  const fieldsToInclude =
    requiredFields.length > 0 ? requiredFields : bodySchema.fields.slice(0, 2);

  const result: Record<string, unknown> = {};
  for (const field of fieldsToInclude) {
    result[field.name] = generateDefaultValue(field, endpointSlug);
  }
  return result;
}

function generateDefaultValue(field: ParameterDef, endpointSlug: string): unknown {
  const name = field.name.toLowerCase();
  const type = field.type.toLowerCase();

  // Gmail raw message field: base64url-encoded RFC 2822 email
  if (name === "raw") {
    const lines = [
      "From: me",
      "To: me",
      "Subject: API Validation Test",
      "Content-Type: text/plain",
      "",
      "Automated API endpoint validation test.",
    ];
    return Buffer.from(lines.join("\r\n")).toString("base64url");
  }

  // Calendar event start/end objects
  if (name === "start" || name === "end") {
    const dt = new Date();
    dt.setMonth(dt.getMonth() + 1); // 1 month in the future
    if (name === "end") dt.setHours(dt.getHours() + 1);
    return { dateTime: dt.toISOString(), timeZone: "UTC" };
  }

  // Date/time string fields
  if (name.includes("datetime") || name.includes("date_time") || type === "date-time") {
    const dt = new Date();
    dt.setMonth(dt.getMonth() + 1);
    return dt.toISOString();
  }

  // Email fields
  if (name.includes("email")) return "test@example.com";

  // Summary / title / name (common calendar/task fields)
  if (name === "summary" || name === "title" || name === "name") return "API Validation Test";

  switch (type) {
    case "string": return "test";
    case "integer":
    case "number": return 1;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "test";
  }
}
