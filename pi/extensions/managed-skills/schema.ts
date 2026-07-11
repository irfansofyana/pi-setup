const OPTIONAL_SCHEMA = Symbol("optional");
type JsonSchema = Record<string, unknown> & { [OPTIONAL_SCHEMA]?: true };

const Schema = {
  Object(properties: Record<string, JsonSchema>): JsonSchema {
    const required = Object.entries(properties)
      .filter(([, schema]) => !schema[OPTIONAL_SCHEMA])
      .map(([name]) => name);
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) => {
        const { [OPTIONAL_SCHEMA]: _optional, ...clean } = schema;
        return [name, clean];
      })),
      required,
      additionalProperties: false,
    };
  },
  String(options: Record<string, unknown> = {}): JsonSchema {
    return { type: "string", ...options };
  },
  Enum(values: readonly string[]): JsonSchema {
    return { type: "string", enum: [...values] };
  },
  Optional(schema: JsonSchema): JsonSchema {
    return { ...schema, [OPTIONAL_SCHEMA]: true };
  },
};

export const manageSkillSchema = Schema.Object({
  action: Schema.Enum(["create", "update", "delete", "list", "view"]),
  name: Schema.Optional(Schema.String({ description: "Kebab-case managed skill name." })),
  description: Schema.Optional(Schema.String({ description: "One-line trigger-focused description for create/update." })),
  body: Schema.Optional(Schema.String({ description: "SKILL.md body in Markdown, without frontmatter, for create/update." })),
});

const learnSkillSchema = Schema.Object({
  action: Schema.Enum(["create", "update"]),
  name: Schema.String({ description: "Kebab-case managed skill name." }),
  description: Schema.String({ description: "One-line trigger-focused description for the managed skill." }),
  body: Schema.String({ description: "SKILL.md body in Markdown, without frontmatter." }),
});

export const learnSchema = Schema.Object({
  memory: Schema.String({ description: "Durable, self-contained lesson to retain in Hindsight: what, when, and why." }),
  context: Schema.Optional(Schema.String({ description: "Optional source context for the lesson." })),
  skill: Schema.Optional(learnSkillSchema),
});
