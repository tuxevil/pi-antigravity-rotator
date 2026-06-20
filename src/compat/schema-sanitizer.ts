export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Gemini's function_declarations accept a restricted subset of JSON Schema.
 * Keywords like `const`, `$schema`, `$ref`, `$defs`, `if/then/else`, `not`,
 * `patternProperties`, etc. are not supported and will cause a 400.
 * This function recursively strips those unsupported keywords.
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	// Keywords Gemini does not support
	const UNSUPPORTED = new Set([
		"const", "$schema", "$id", "$ref", "$defs", "definitions",
		"if", "then", "else", "not",
		"patternProperties", "unevaluatedProperties", "unevaluatedItems",
		"contentEncoding", "contentMediaType", "examples",
		"exclusiveMinimum", "exclusiveMaximum", "minimum", "maximum",
		"multipleOf", "minLength", "maxLength", "pattern",
		"minItems", "maxItems", "uniqueItems",
		"minProperties", "maxProperties", "title", "default",
	]);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED.has(key)) continue;

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value)) {
				// Special case: all items are pure {const: value} — this is the
				// JSON Schema way of writing an enum. Convert to Gemini's `enum` array.
				const allConst = value.every(
					(item) => isRecord(item) && Object.keys(item).length === 1 && "const" in item,
				);
				if (allConst) {
					out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
					// Infer type:string when all const values are strings (covers most tool params)
					if (value.every((item) => typeof (item as Record<string, unknown>)["const"] === "string")) {
						if (!out["type"]) out["type"] = "string";
					}
				} else {
					const cleaned = value.map(sanitizeGeminiSchema).filter(
						// Drop entries that become empty objects after sanitisation
						(v) => isRecord(v) && Object.keys(v).length > 0,
					);
					// If only one variant remains, unwrap it (Gemini prefers flat schemas)
					if (cleaned.length === 1) {
						Object.assign(out, cleaned[0]);
					} else if (cleaned.length > 1) {
						out[key] = cleaned;
					}
					// cleaned.length === 0: skip entirely
				}
			}
			continue;
		}

		// Inline union type: `type: ["number","null"]`. Gemini's proto `type`
		// field is a single enum, not repeating — collapse to the first non-null
		// type and lift nullability into the proto-supported `nullable` flag.
		if (key === "type" && Array.isArray(value)) {
			const nonNull = (value as unknown[]).filter((t) => t !== "null");
			if ((value as unknown[]).includes("null")) out["nullable"] = true;
			out["type"] = (nonNull[0] ?? "string");
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, sanitizeGeminiSchema(v)]),
			);
			continue;
		}

		if (key === "items") {
			out[key] = sanitizeGeminiSchema(value);
			continue;
		}

		out[key] = isRecord(value) ? sanitizeGeminiSchema(value) : value;
	}
	return out;
}

/**
 * Lighter sanitization for Claude models routed through Gemini's API.
 * Gemini's outer API still validates schemas before routing to Claude, so
 * we must remove fields Gemini's protobuf doesn't know about (like `const`,
 * `$ref`, etc.). However, unlike the Gemini-native sanitizer, we KEEP
 * standard JSON Schema Draft 2020-12 keywords (minimum, maximum, pattern,
 * etc.) that Claude requires and that Gemini's API does pass through.
 */
export function sanitizeClaudeViaGeminiSchema(schema: unknown): unknown {
	if (!isRecord(schema)) return schema;

	// Only remove fields that Gemini's API layer truly rejects at the network level.
	// We keep standard Draft 2020-12 keywords but must strip exclusiveMinimum/exclusiveMaximum
	// as boolean values (Draft 4) — the API layer rejects them even for Claude-bound requests.
	const UNSUPPORTED = new Set([
		"$schema", "$id", "$ref", "$defs", "definitions",
		"if", "then", "else", "not",
		"patternProperties", "unevaluatedProperties", "unevaluatedItems",
		"contentEncoding", "contentMediaType",
		// Gemini's protobuf layer rejects these regardless of target model
		"exclusiveMinimum", "exclusiveMaximum",
	]);

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (UNSUPPORTED.has(key)) continue;

		// `const` is not supported by Gemini's API — convert to a single-value enum
		if (key === "const") {
			out["enum"] = [value];
			continue;
		}

		if (key === "anyOf" || key === "oneOf" || key === "allOf") {
			if (Array.isArray(value)) {
				// Case 1: all items are pure {const: value} — convert to flat enum.
				const allPureConst = value.every(
					(item) => isRecord(item) && Object.keys(item).length === 1 && "const" in item,
				);
				if (allPureConst) {
					out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
					if (value.every((item) => typeof (item as Record<string, unknown>)["const"] === "string")) {
						if (!out["type"]) out["type"] = "string";
					}
					continue;
				}

				// Case 2: all items are {type: T, const: V} (same type, each with a const).
				// e.g. [{type:"string",const:"fact"},{type:"string",const:"lesson"}]
				// Merge into a single flat {type: T, enum: [V1, V2, ...]} — avoids
				// the redundant anyOf-with-single-enum pattern that Claude rejects.
				const allTypeConst = value.every(
					(item) =>
						isRecord(item) &&
						Object.keys(item).length === 2 &&
						"type" in item &&
						"const" in item,
				);
				if (allTypeConst) {
					const firstType = (value[0] as Record<string, unknown>)["type"];
					const allSameType = value.every((item) => (item as Record<string, unknown>)["type"] === firstType);
					if (allSameType) {
						if (!out["type"]) out["type"] = firstType;
						out["enum"] = value.map((item) => (item as Record<string, unknown>)["const"]);
						continue;
					}
				}

				// Sanitize all variants first.
				const cleaned = value.map(sanitizeClaudeViaGeminiSchema).filter(
					(v) => isRecord(v) && Object.keys(v).length > 0,
				) as Record<string, unknown>[];

				if (cleaned.length === 0) {
					// All variants collapsed to nothing — skip entirely.
					continue;
				}

				// Case 3: nullable pattern — anyOf/oneOf with exactly one {type:"null"}
				// variant and one or more real variants. Convert to the real variant
				// with nullable:true. This is lossless — Gemini's proto supports nullable.
				// e.g. anyOf:[{type:"string"},{type:"null"}] → {type:"string",nullable:true}
				if (key !== "allOf") {
					const nullIdx = cleaned.findIndex((v) => v.type === "null" && Object.keys(v).length === 1);
					if (nullIdx !== -1) {
						const nonNull = cleaned.filter((_, i) => i !== nullIdx);
						if (nonNull.length === 1) {
							Object.assign(out, nonNull[0], { nullable: true });
							continue;
						}
						if (nonNull.length > 1) {
							// Multiple non-null variants + null → collapse non-null variants,
							// then mark nullable. Still lossy but preserves nullability.
							Object.assign(out, nonNull[0], { nullable: true });
							continue;
						}
					}
				}

				// Case 4: allOf — deep merge all variants (allOf = intersection).
				// Merging properties from all variants is semantically correct.
				if (key === "allOf") {
					const merged: Record<string, unknown> = {};
					let mergedProperties: Record<string, unknown> = {};
					let mergedRequired: string[] = [];
					for (const variant of cleaned) {
						for (const [vk, vv] of Object.entries(variant)) {
							if (vk === "properties" && isRecord(vv)) {
								mergedProperties = { ...mergedProperties, ...vv };
							} else if (vk === "required" && Array.isArray(vv)) {
								mergedRequired = [...new Set([...mergedRequired, ...vv])];
							} else {
								merged[vk] = vv;
							}
						}
					}
					if (Object.keys(mergedProperties).length > 0) merged["properties"] = mergedProperties;
					if (mergedRequired.length > 0) merged["required"] = mergedRequired;
					Object.assign(out, merged);
					continue;
				}

				// Case 5: anyOf/oneOf where all variants are objects with properties —
				// merge all properties together, making all optional (union of shapes).
				// This is mildly lossy (accepts wider input) but doesn't reject valid inputs.
				const allObjects = cleaned.every(
					(v) => v.type === "object" && isRecord(v.properties),
				);
				if (allObjects && cleaned.length > 1) {
					const unionProperties: Record<string, unknown> = {};
					for (const variant of cleaned) {
						const props = variant.properties as Record<string, unknown>;
						for (const [pk, pv] of Object.entries(props)) {
							if (!(pk in unionProperties)) unionProperties[pk] = pv;
						}
					}
					// Only keep required fields that exist in ALL variants
					const allRequired = cleaned.map((v) =>
						Array.isArray(v.required) ? new Set(v.required as string[]) : new Set<string>(),
					);
					const commonRequired = [...allRequired[0]].filter((r) =>
						allRequired.every((s) => s.has(r)),
					);
					const base = { ...cleaned[0] };
					base["properties"] = unionProperties;
					if (commonRequired.length > 0) {
						base["required"] = commonRequired;
					} else {
						delete base["required"];
					}
					Object.assign(out, base);
					continue;
				}

				// Fallback: collapse to the first valid variant.
				// Gemini's Schema proto serialization corrupts complex anyOf/oneOf
				// during the round-trip to Claude, causing JSON Schema draft 2020-12
				// validation failures. Collapsing is lossy but functional — the tool
				// still works, just with a narrower accepted input type.
				Object.assign(out, cleaned[0]);
			}
			continue;
		}

		// Inline union type: `type: ["number","null"]`. Gemini's proto `type`
		// field is a single enum, not repeating — an array value triggers a 400
		// ('Proto field is not repeating'). Collapse to the first non-null type
		// and lift nullability into the proto-supported `nullable` flag.
		if (key === "type" && Array.isArray(value)) {
			const nonNull = (value as unknown[]).filter((t) => t !== "null");
			if ((value as unknown[]).includes("null")) out["nullable"] = true;
			out["type"] = (nonNull[0] ?? "string");
			continue;
		}

		if (key === "properties" && isRecord(value)) {
			out[key] = Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, sanitizeClaudeViaGeminiSchema(v)]),
			);
			continue;
		}

		if (key === "items") {
			out[key] = sanitizeClaudeViaGeminiSchema(value);
			continue;
		}

		out[key] = isRecord(value) ? sanitizeClaudeViaGeminiSchema(value) : value;
	}
	return out;
}
