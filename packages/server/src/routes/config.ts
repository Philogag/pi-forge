import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthProviderNotFoundError,
  getAllPromptOverrides,
  getAllSkillOverrides,
  liveProvidersListing,
  listPrompts,
  listSkills,
  PromptNotFoundError,
  readAuthSummary,
  readModelsJsonRedacted,
  readSettings,
  removeApiKey,
  setPromptEnabled,
  setSkillEnabled,
  SkillNotFoundError,
  updateSettings,
  writeApiKey,
  writeModelsJson,
  type ModelsJson,
} from "../config-manager.js";
import { config } from "../config.js";
import { buildExportTar, importConfigFromBuffer, MAX_IMPORT_BYTES } from "../config-export.js";
import {
  PluginProviderNotFoundError,
  PluginProviderNotRefreshableError,
  refreshPluginProvider,
} from "../providers/refresh.js";
import {
  buildSkillsExportTar,
  SkillsDirectoryEmptyError,
  importSkillsFromFiles,
  importSkillsFromTar,
  MAX_SKILLS_IMPORT_BYTES,
} from "../skills-export.js";
import {
  ensureProjectLoaded as mcpEnsureProjectLoaded,
  getStatus as mcpGetStatus,
} from "../mcp/manager.js";
import {
  getConfigDeclaration,
  getPluginConfigState,
  refreshPluginConfigs,
} from "../plugin-config/registry.js";
import {
  ConfigFileError,
  putRaw,
  putValues,
  readDeclarationValues,
  validateValues,
} from "../plugin-config/store.js";
import type {
  PluginConfigListResponse,
  PluginConfigSummary,
  SavePluginConfigBody,
} from "../plugin-config/types.js";
import { SETTINGS_EXTENSIONS_FILE } from "../plugin-config/types.js";
import { BUILTIN_TOOL_NAMES, reloadAllLiveSessions } from "../session-registry.js";
import { discoverExtensionResources } from "../extensions-discovery.js";
import { installPackage, listPackages, removePackage } from "../extensions-manager.js";
import {
  getAllToolOverrides,
  getProjectToolState,
  isToolEffective,
  readToolOverrides,
  setProjectToolOverride,
  setToolEnabled,
  type ToolFamily,
  type ToolOverrideState,
} from "../tool-overrides.js";
import { getProject } from "../project-manager.js";
import {
  readSandboxSettings,
  validateSandboxToolEnv,
  writeSandboxSettings,
} from "../sandbox-settings.js";
import {
  DEFAULT_THEME_COLORS,
  readThemeConfig,
  resetThemeConfig,
  THEME_COLOR_KEYS,
  validateThemeConfig,
  writeThemeConfig,
  type ServerThemeConfig,
} from "../theme-config.js";
import { errorSchema } from "./_schemas.js";

const modelsJsonSchema = {
  type: "object",
  required: ["providers"],
  additionalProperties: true,
  properties: {
    // Loose validation: route accepts any shape under `providers` and lets
    // the SDK reject malformed configs at load time. Tighter validation can
    // come once the dev plan freezes the provider config schema.
    providers: { type: "object", additionalProperties: true },
  },
} as const;

const settingsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    // Each field accepts its real type OR null (which the handler interprets
    // as "delete this key"). Loose typing on purpose — strict enums break the
    // null-delete contract documented on the PUT route. The SDK validates
    // settings.json shape on next read.
    defaultProvider: { type: ["string", "null"] },
    defaultModel: { type: ["string", "null"] },
    defaultThinkingLevel: { type: ["string", "null"] },
    skills: { type: ["array", "null"], items: { type: "string" } },
    enableSkillCommands: { type: ["boolean", "null"] },
  },
} as const;

const sandboxSettingsSchema = {
  type: "object",
  required: ["enabled", "toolEnv"],
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    uid: { type: "integer" },
    gid: { type: "integer" },
    home: { type: "string" },
    toolEnv: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

const sandboxSettingsBodySchema = {
  type: "object",
  required: ["toolEnv"],
  additionalProperties: false,
  properties: {
    toolEnv: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

const themeColorsSchema = {
  type: "object",
  required: [...THEME_COLOR_KEYS],
  additionalProperties: false,
  properties: Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [key, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }]),
  ),
} as const;

const themeConfigSchema = {
  type: "object",
  required: ["enabled", "colors", "defaults"],
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    colors: themeColorsSchema,
    defaults: themeColorsSchema,
  },
} as const;

const themeConfigBodySchema = {
  type: "object",
  required: ["enabled", "colors"],
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    colors: themeColorsSchema,
  },
} as const;

const authSummarySchema = {
  type: "object",
  required: ["providers"],
  properties: {
    providers: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["configured"],
        properties: {
          configured: { type: "boolean" },
          source: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
} as const;

const providerModelSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "contextWindow",
    "maxTokens",
    "reasoning",
    "input",
    "hasAuth",
    "supportedThinkingLevels",
  ],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    contextWindow: { type: "integer" },
    maxTokens: { type: "integer" },
    reasoning: { type: "boolean" },
    input: { type: "array", items: { type: "string" } },
    hasAuth: { type: "boolean" },
    supportedThinkingLevels: { type: "array", items: { type: "string" } },
  },
} as const;

const providersListingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ready", "errors", "providers"],
  properties: {
    ready: { type: "boolean" },
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "error"],
        properties: {
          path: { type: "string" },
          error: { type: "string" },
        },
      },
    },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "models"],
        properties: {
          provider: { type: "string" },
          via: { type: "string" },
          package: { type: "string" },
          models: { type: "array", items: providerModelSchema },
        },
      },
    },
  },
} as const;

const skillSchema = {
  type: "object",
  required: [
    "name",
    "description",
    "source",
    "filePath",
    "enabled",
    "effective",
    "disableModelInvocation",
  ],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    source: { type: "string", enum: ["global", "project", "extension"] },
    filePath: { type: "string" },
    /** Identifier of the package that contributed this skill (only when source === "extension"). */
    extensionPath: { type: "string" },
    enabled: { type: "boolean" },
    /** Tri-state per-project override; absent = inherit from global. */
    projectOverride: { type: "string", enum: ["enabled", "disabled"] },
    /** Resolved state the agent in the queried project would see. */
    effective: { type: "boolean" },
    disableModelInvocation: { type: "boolean" },
  },
} as const;

/**
 * Surfaced verbatim from the SDK's `loadSkills` so the SkillsTab can
 * tell the user *why* a file under `.pi/skills/` didn't load — most
 * commonly a name collision when a top-level `<dir>/foo.md` skill
 * lacks `name:` frontmatter and falls back to the parent dir name.
 * Without this, those skills disappear silently and the user has no
 * way to debug the authoring.
 */
const skillDiagnosticSchema = {
  type: "object",
  required: ["type", "message"],
  properties: {
    type: { type: "string", enum: ["warning", "error", "collision"] },
    message: { type: "string" },
    path: { type: "string" },
    collision: {
      type: "object",
      required: ["resourceType", "name", "winnerPath", "loserPath"],
      properties: {
        resourceType: { type: "string" },
        name: { type: "string" },
        winnerPath: { type: "string" },
        loserPath: { type: "string" },
      },
    },
  },
} as const;

/**
 * Mirrors `skillSchema`. No `extensionPath` (no package-contributed
 * prompts source today; see `listPrompts` doc-comment) and no
 * `disableModelInvocation` (skills-only concept). `argumentHint`
 * surfaces the optional bash-style usage hint from the prompt's
 * frontmatter so the slash-command palette can render it.
 */
const promptSchema = {
  type: "object",
  required: ["name", "description", "source", "filePath", "enabled", "effective"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    argumentHint: { type: "string" },
    source: { type: "string", enum: ["global", "project"] },
    filePath: { type: "string" },
    enabled: { type: "boolean" },
    projectOverride: { type: "string", enum: ["enabled", "disabled"] },
    effective: { type: "boolean" },
  },
} as const;

function internalError(reply: FastifyReply, err: unknown): FastifyReply {
  reply.log.error({ err }, "config route error");
  return reply.code(500).send({ error: "internal_error" });
}

export const configRoutes: FastifyPluginAsync = async (fastify) => {
  // ---------------------- models.json ----------------------
  fastify.get(
    "/config/models",
    {
      schema: {
        description:
          "Read `models.json` (custom provider configurations). Inline `apiKey` " +
          "fields, including command values such as `!op read ...`, are returned " +
          "as `***REDACTED***` so the raw secret never leaves the server. " +
          "Legacy `apiKeyCommand` fields are migrated to SDK 0.80 `apiKey` command values. " +
          "The persisted file is unchanged " +
          "— PUT /config/models takes the actual values; the redaction is on " +
          "the read path only.",
        tags: ["config"],
        response: { 200: modelsJsonSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readModelsJsonRedacted();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: ModelsJson }>(
    "/config/models",
    {
      schema: {
        description:
          "Replace `models.json` atomically. The SDK validates the structure " +
          "on the next session creation; malformed configs are rejected then.",
        tags: ["config"],
        body: modelsJsonSchema,
        response: { 200: modelsJsonSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        await writeModelsJson(req.body);
        return req.body;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- live providers ----------------------
  fastify.get(
    "/config/providers",
    {
      schema: {
        description:
          "Live provider + model listing assembled from the SDK's ModelRegistry " +
          "(combines built-in models with anything in `models.json`). Each model " +
          "carries a `hasAuth` boolean so the UI can dim entries with no key.",
        tags: ["config"],
        response: { 200: providersListingSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await liveProvidersListing();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- settings.json ----------------------
  fastify.get(
    "/config/settings",
    {
      schema: {
        description: "Read `settings.json` (default provider/model, modes, skills list, etc).",
        tags: ["config"],
        response: { 200: settingsSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readSettings();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: Record<string, unknown> }>(
    "/config/settings",
    {
      schema: {
        description:
          "Partial-merge update for `settings.json`. Sending `null` for any key " +
          "deletes it; other values overwrite. Atomic write.",
        tags: ["config"],
        body: settingsSchema,
        response: { 200: settingsSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        return await updateSettings(req.body);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- sandbox settings ----------------------
  fastify.get(
    "/config/sandbox",
    {
      schema: {
        description:
          "Read sandbox mode status and the persisted environment variables injected into agent tool calls.",
        tags: ["config"],
        response: { 200: sandboxSettingsSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        const settings = await readSandboxSettings();
        return {
          enabled: config.agentToolSandbox.enabled,
          uid: config.agentToolSandbox.uid,
          gid: config.agentToolSandbox.gid,
          home: config.agentToolSandbox.home,
          toolEnv: settings.toolEnv,
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: { toolEnv: Record<string, string> } }>(
    "/config/sandbox",
    {
      schema: {
        description:
          "Replace the persisted environment variables injected into future agent tool calls. Sandbox enablement and UID/GID remain deploy-time configuration.",
        tags: ["config"],
        body: sandboxSettingsBodySchema,
        response: { 200: sandboxSettingsSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      let toolEnv: Record<string, string>;
      try {
        toolEnv = validateSandboxToolEnv(req.body.toolEnv);
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_sandbox_settings",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const settings = await writeSandboxSettings({ toolEnv });
        return {
          enabled: config.agentToolSandbox.enabled,
          uid: config.agentToolSandbox.uid,
          gid: config.agentToolSandbox.gid,
          home: config.agentToolSandbox.home,
          toolEnv: settings.toolEnv,
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- global UI theme ----------------------
  fastify.get(
    "/config/theme",
    {
      schema: {
        description:
          "Read the global server-side UI color theme. Colors are 6-digit hex values and apply to broad chat/chrome surfaces.",
        tags: ["config"],
        response: { 200: themeConfigSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        const theme = await readThemeConfig();
        return { ...theme, defaults: DEFAULT_THEME_COLORS };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Body: ServerThemeConfig }>(
    "/config/theme",
    {
      schema: {
        description:
          "Replace the global server-side UI color theme. Colors are 6-digit hex values and affect future and current browser tabs after reload/save.",
        tags: ["config"],
        body: themeConfigBodySchema,
        response: { 200: themeConfigSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      let theme: ServerThemeConfig;
      try {
        theme = validateThemeConfig(req.body);
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_theme_config",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const saved = await writeThemeConfig(theme);
        return { ...saved, defaults: DEFAULT_THEME_COLORS };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.delete(
    "/config/theme",
    {
      schema: {
        description:
          "Reset the global server-side UI color theme to built-in defaults and disable it.",
        tags: ["config"],
        response: { 200: themeConfigSchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        const reset = await resetThemeConfig();
        return { ...reset, defaults: DEFAULT_THEME_COLORS };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- auth.json (presence only) ----------------------
  fastify.get(
    "/config/auth",
    {
      schema: {
        description:
          "Provider credential PRESENCE map. Never includes actual key values — " +
          "the response shape is presence + source + label only.",
        tags: ["config"],
        response: { 200: authSummarySchema, 500: errorSchema },
      },
    },
    async (_req, reply) => {
      try {
        return await readAuthSummary();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{ Params: { provider: string }; Body: { apiKey: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description:
          "Store an API key for a provider. The key is written to `auth.json` " +
          "(file-locked via the SDK); existing keys for OTHER providers are " +
          "untouched. Body: `{ apiKey }`.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        body: {
          type: "object",
          required: ["apiKey"],
          additionalProperties: false,
          properties: { apiKey: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["provider", "configured"],
            properties: {
              provider: { type: "string" },
              configured: { type: "boolean", const: true },
            },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        await writeApiKey(req.params.provider, req.body.apiKey);
        return { provider: req.params.provider, configured: true };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { provider: string } }>(
    "/config/auth/:provider",
    {
      schema: {
        description: "Remove credentials for a provider.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        response: { 204: { type: "null" }, 404: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
      try {
        await removeApiKey(req.params.provider);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof AuthProviderNotFoundError) {
          return reply.code(404).send({ error: "auth_provider_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- plugin provider refresh ----------------------
  // Trigger model re-discovery for one plugin-registered provider. The
  // refresh prefers the extension's `refreshModels` callback and falls back
  // to SDK standard `/v1/models` discovery; results are persisted to
  // models-store.json (M1) so later listings read them without a re-refresh.
  // 404 for unregistered names; 400 when the provider is a native
  // registration with no refresh semantics; other failures map to 500
  // `agent_error`.
  fastify.post<{ Params: { provider: string } }>(
    "/config/providers/:provider/refresh",
    {
      schema: {
        summary: "Refresh models for a plugin-provided provider",
        description:
          "Trigger model re-discovery for one plugin-registered provider " +
          "(prefers the extension's `refreshModels` callback; falls back to " +
          "SDK standard `/v1/models` discovery). Result is persisted to " +
          "models-store.json so later listings see it without a re-refresh. " +
          "404 `not_found` for unregistered names; 400 `not_refreshable` for " +
          "native registrations; other failures surface as 500 `agent_error`.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["provider"],
          properties: { provider: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["provider", "models"],
            properties: {
              provider: { type: "string" },
              models: { type: "array", items: providerModelSchema },
            },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const models = await refreshPluginProvider(req.params.provider);
        return { provider: req.params.provider, models };
      } catch (err) {
        if (err instanceof PluginProviderNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: err.message });
        }
        if (err instanceof PluginProviderNotRefreshableError) {
          return reply.code(400).send({ error: "not_refreshable", message: err.message });
        }
        // 其他失败：500 `agent_error`（与 /config/reload 等路由一致）。
        reply.log.error({ err }, "plugin provider refresh failed");
        return reply.code(500).send({
          error: "agent_error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ---------------------- skills ----------------------
  fastify.get<{ Querystring: { projectId: string } }>(
    "/config/skills",
    {
      schema: {
        description:
          "List skills discovered for a project. Skills come from two sources: " +
          "the global `~/.pi/agent/skills/` and the project-local `.pi/skills/`. " +
          "Each skill carries `enabled` reflecting whether it's listed in " +
          "`settings.skills`. `diagnostics` surfaces SDK warnings for files " +
          "the loader rejected (missing description, name collision, etc.) " +
          "so the UI can render actionable errors. Required: `?projectId=`.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills", "diagnostics"],
            properties: {
              skills: { type: "array", items: skillSchema },
              diagnostics: { type: "array", items: skillDiagnosticSchema },
            },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const { skills, diagnostics } = await listSkills(project.path, project.id);
        return { skills, diagnostics };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // Cascade view: every per-project override across every project,
  // for the Settings UI's per-skill expand-and-show-all-projects
  // affordance. Single small JSON file on disk; one fetch per
  // tab-open is fine.
  fastify.get(
    "/config/skills/overrides",
    {
      schema: {
        description:
          "All per-project skill overrides across all projects. Returns " +
          "`{ projects: { <projectId>: { enable: [...], disable: [...] } } }`. " +
          "Absent project keys mean 'no overrides defined' (the project " +
          "inherits everything from global).",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  required: ["enable", "disable"],
                  properties: {
                    enable: { type: "array", items: { type: "string" } },
                    disable: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        return await getAllSkillOverrides();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { name: string };
    Querystring: { projectId: string };
    Body: { enabled: boolean; scope?: "global" | "project" };
  }>(
    "/config/skills/:name/enabled",
    {
      schema: {
        description:
          "Toggle a skill's enabled state. Default scope=`global` mutates " +
          "pi's `settings.skills` (canonical enable/disable list shared with " +
          "the pi TUI). scope=`project` writes to the pi-forge-private " +
          "overrides file at `${FORGE_DATA_DIR}/skills-overrides.json` " +
          "for the project named in `?projectId=`. Project-scope overrides " +
          "follow tri-state semantics: `enabled` adds, `disabled` removes; " +
          "absence (cleared via DELETE) inherits from global. Skill changes " +
          "apply on the NEXT session created in the affected project — live " +
          "sessions keep the skill set they booted with.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            scope: { type: "string", enum: ["global", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const scope = req.body.scope ?? "global";
        const skills = await setSkillEnabled(req.params.name, req.body.enabled, project.path, {
          scope,
          projectId: project.id,
        });
        return { skills };
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          return reply.code(404).send({ error: "skill_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{
    Params: { name: string };
    Querystring: { projectId: string };
  }>(
    "/config/skills/:name/enabled",
    {
      schema: {
        description:
          "Clear a skill's PROJECT override (= return it to inherit from " +
          "global). Does not affect pi's settings.skills. Use the PUT " +
          "endpoint to change global state.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["skills"],
            properties: { skills: { type: "array", items: skillSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const skills = await setSkillEnabled(req.params.name, undefined, project.path, {
          scope: "project",
          projectId: project.id,
        });
        return { skills };
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          return reply.code(404).send({ error: "skill_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- prompts ----------------------
  // Mirrors the skills routes end-to-end (list / overrides cascade /
  // PUT enabled / DELETE override). Same tri-state per-project
  // semantics; see the skills section above for the shape rationale.
  // The pi SDK exposes prompts via `DefaultResourceLoader.getPrompts()`
  // — see `listPrompts` in `config-manager.ts` for how we discover them
  // and inject pattern overrides through the SettingsManager.
  fastify.get<{ Querystring: { projectId: string } }>(
    "/config/prompts",
    {
      schema: {
        description:
          "List prompt templates discovered for a project. Sources: global " +
          "`~/.pi/agent/prompts/` and project-local `.pi/prompts/`. Each " +
          "prompt carries `enabled` reflecting whether it's listed in " +
          "`settings.prompts`. `diagnostics` mirrors the skills shape " +
          "(currently always empty — the SDK doesn't surface prompt " +
          "collisions today). Required: `?projectId=`.",
        tags: ["config"],
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["prompts", "diagnostics"],
            properties: {
              prompts: { type: "array", items: promptSchema },
              diagnostics: { type: "array", items: skillDiagnosticSchema },
            },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const { prompts, diagnostics } = await listPrompts(project.path, project.id);
        return { prompts, diagnostics };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.get(
    "/config/prompts/overrides",
    {
      schema: {
        description:
          "All per-project prompt overrides across all projects. Same " +
          "shape as `/config/skills/overrides`. Returns " +
          "`{ projects: { <projectId>: { enable: [...], disable: [...] } } }`. " +
          "Absent project keys mean 'no overrides defined' (the project " +
          "inherits everything from global).",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  required: ["enable", "disable"],
                  properties: {
                    enable: { type: "array", items: { type: "string" } },
                    disable: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        return await getAllPromptOverrides();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { name: string };
    Querystring: { projectId: string };
    Body: { enabled: boolean; scope?: "global" | "project" };
  }>(
    "/config/prompts/:name/enabled",
    {
      schema: {
        description:
          "Toggle a prompt's enabled state. Default scope=`global` mutates " +
          "pi's `settings.prompts`. scope=`project` writes to the pi-forge-" +
          "private overrides file at `${FORGE_DATA_DIR}/prompts-overrides.json` " +
          "for the project named in `?projectId=`. Same tri-state semantics " +
          "as `/config/skills/:name/enabled`. Prompt changes apply on the " +
          "NEXT session created in the affected project — live sessions " +
          "keep the prompt set they booted with.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            scope: { type: "string", enum: ["global", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["prompts"],
            properties: { prompts: { type: "array", items: promptSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const scope = req.body.scope ?? "global";
        const prompts = await setPromptEnabled(req.params.name, req.body.enabled, project.path, {
          scope,
          projectId: project.id,
        });
        return { prompts };
      } catch (err) {
        if (err instanceof PromptNotFoundError) {
          return reply.code(404).send({ error: "prompt_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  fastify.delete<{
    Params: { name: string };
    Querystring: { projectId: string };
  }>(
    "/config/prompts/:name/enabled",
    {
      schema: {
        description:
          "Clear a prompt's PROJECT override (= return it to inherit from " +
          "global). Does not affect pi's settings.prompts. Use the PUT " +
          "endpoint to change global state.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["prompts"],
            properties: { prompts: { type: "array", items: promptSchema } },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.query.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      try {
        const prompts = await setPromptEnabled(req.params.name, undefined, project.path, {
          scope: "project",
          projectId: project.id,
        });
        return { prompts };
      } catch (err) {
        if (err instanceof PromptNotFoundError) {
          return reply.code(404).send({ error: "prompt_not_found" });
        }
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- export / import ----------------------
  // Two routes that round-trip the pi-forge's portable config
  // (mcp.json + settings.json + models.json + skills-overrides.json +
  // tool-overrides.json — see config-export.ts header for what's in
  // and what's out).
  fastify.get(
    "/config/export",
    {
      schema: {
        description:
          "Stream a `.tar.gz` of the portable pi-forge config: " +
          "`mcp.json`, `settings.json`, `models.json`, " +
          "`skills-overrides.json`, and `tool-overrides.json`. Excludes " +
          "`auth.json` (provider keys / OAuth tokens), `projects.json` " +
          "(installation-bound paths), and the auto-generated " +
          "`jwt-secret`/`password-hash` files. The header " +
          "`X-Pi-Forge-Files` lists the names actually included so a " +
          "client can warn when a file was missing on disk and " +
          "therefore omitted from the export.",
        tags: ["config"],
        response: {
          200: {
            description: "gzip-compressed tar of the included files",
            type: "string",
            format: "binary",
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        const { files, stream } = await buildExportTar();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        reply
          .header("Content-Type", "application/gzip")
          .header("Content-Disposition", `attachment; filename="pi-forge-config-${ts}.tar.gz"`)
          .header("X-Pi-Forge-Files", files.join(","));
        return reply.send(stream);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.post(
    "/config/import",
    {
      schema: {
        description:
          "Restore a `.tar.gz` previously produced by `/config/export`. " +
          "The archive must contain only the allow-listed top-level " +
          "files (`mcp.json`, `settings.json`, `models.json`, " +
          "`skills-overrides.json`, `tool-overrides.json`) — anything " +
          "else is reported in `skipped`. Each accepted file is parsed " +
          "as JSON; ALL files must validate before ANY are written. " +
          "Imported files land atomically (`.tmp` + rename). " +
          "**Provider auth is NOT included in exports** — re-authenticate " +
          "providers via the Auth settings page after import. Note that " +
          "`*-overrides.json` `projectId` keys are local UUIDs; importing " +
          "onto an installation with a different `projects.json` will " +
          "leave orphan entries that are silently ignored at session-" +
          "create time.",
        tags: ["config"],
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            required: ["imported", "skipped", "errors"],
            properties: {
              imported: { type: "array", items: { type: "string" } },
              skipped: { type: "array", items: { type: "string" } },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  required: ["file", "reason"],
                  properties: {
                    file: { type: "string" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          413: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req: FastifyRequest, reply) => {
      // Single multipart file expected. Anything beyond the first is
      // ignored — the import contract is "one tar.gz per request."
      let buf: Buffer;
      try {
        const file = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
        if (file === undefined) {
          return reply.code(400).send({ error: "no_file" });
        }
        buf = await file.toBuffer();
        // toBuffer caps silently at the size limit; detect via the
        // `truncated` flag the multipart stream sets, otherwise the
        // user gets a confused "tar parse error" instead of the right
        // 413 with a clear message.
        if (file.file.truncated) {
          return reply.code(413).send({
            error: "file_too_large",
            message: `import archive exceeds ${MAX_IMPORT_BYTES} bytes`,
          });
        }
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_multipart",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const summary = await importConfigFromBuffer(buf);
        return summary;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- skills export / import ----------------------
  // Skills tree export. Streams a tar.gz of every file under
  // `${piConfigDir}/skills/` — single-file skills (`<name>.md`) and
  // directory skills (`<name>/SKILL.md` plus assets) round-trip
  // verbatim. When the skills directory is missing or empty, the
  // route returns 409 with a stable code so the UI can show "no
  // skills to export" instead of triggering a download — see the
  // SkillsDirectoryEmptyError class in skills-export.ts for why we
  // don't ship an empty archive.
  fastify.get(
    "/config/skills/export",
    {
      schema: {
        description:
          "Stream a `.tar.gz` of every file under `${piConfigDir}/skills/`. " +
          "Single-file (`<name>.md`) and directory skills (`<name>/SKILL.md` + " +
          "assets) both round-trip. Returns 409 `skills_directory_empty` when " +
          "the skills tree is missing or contains no files.",
        tags: ["config"],
        response: {
          200: {
            description: "gzip-compressed tar of the skills directory contents",
            type: "string",
            format: "binary",
          },
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        const { fileCount, stream } = await buildSkillsExportTar();
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        reply
          .header("Content-Type", "application/gzip")
          .header("Content-Disposition", `attachment; filename="pi-forge-skills-${ts}.tar.gz"`)
          .header("X-Pi-Forge-File-Count", String(fileCount));
        return reply.send(stream);
      } catch (err) {
        if (err instanceof SkillsDirectoryEmptyError) {
          return reply.code(409).send({ error: "skills_directory_empty" });
        }
        return internalError(reply, err);
      }
    },
  );

  // Skills tree import. Two shapes accepted:
  //   1. A single multipart file part — server treats it as a tar.gz
  //      and delegates to `importSkillsFromTar`.
  //   2. Multiple multipart file parts — typical of an
  //      `<input webkitdirectory>` folder pick. Each part's `filename`
  //      carries the relative path inside the picked folder; server
  //      writes each into the skills tree after the path-safety
  //      filter.
  // The route auto-detects: if exactly one part is present AND its
  // filename ends in `.tar.gz` / `.tgz`, it's treated as a tar; in any
  // other case the parts are imported as discrete files.
  fastify.post(
    "/config/skills/import",
    {
      schema: {
        description:
          "Restore a skills tar.gz OR upload a folder of skill files. " +
          "Tar.gz path: must contain only relative paths under the skills " +
          "directory; absolute paths and `..` traversal are rejected. " +
          "Folder upload path: each multipart `filename` is treated as a " +
          "relative path inside the skills tree (same safety filter). " +
          "Existing files at colliding paths are overwritten.",
        tags: ["config"],
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            required: ["imported", "skipped"],
            properties: {
              imported: { type: "array", items: { type: "string" } },
              skipped: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "reason"],
                  properties: {
                    name: { type: "string" },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          400: errorSchema,
          413: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req: FastifyRequest, reply) => {
      // Collect every multipart file part up front. We need to know the
      // count + filenames before deciding tar-vs-folder, so we buffer
      // each part's bytes (capped per-part by the multipart limit) and
      // then dispatch to the right importer.
      const parts: { filename: string; buffer: Buffer }[] = [];
      try {
        const iter = req.files({ limits: { fileSize: MAX_SKILLS_IMPORT_BYTES } });
        for await (const f of iter) {
          if (f.file.truncated) {
            return reply.code(413).send({
              error: "file_too_large",
              message: `part "${f.filename}" exceeds ${MAX_SKILLS_IMPORT_BYTES} bytes`,
            });
          }
          const buf = await f.toBuffer();
          if (f.file.truncated) {
            return reply.code(413).send({
              error: "file_too_large",
              message: `part "${f.filename}" exceeds ${MAX_SKILLS_IMPORT_BYTES} bytes`,
            });
          }
          parts.push({ filename: f.filename, buffer: buf });
        }
      } catch (err) {
        return reply.code(400).send({
          error: "invalid_multipart",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (parts.length === 0) {
        return reply.code(400).send({ error: "no_file" });
      }
      try {
        const isTarball =
          parts.length === 1 &&
          (parts[0]!.filename.endsWith(".tar.gz") || parts[0]!.filename.endsWith(".tgz"));
        const summary = isTarball
          ? await importSkillsFromTar(parts[0]!.buffer)
          : await importSkillsFromFiles(parts);
        return summary;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- per-tool overrides ----------------------
  // Surface the unified tool view (builtins + per-MCP-server tools)
  // and a single toggle endpoint. The agent-side filter that applies
  // these overrides lives in `session-registry.buildToolsAllowlist`
  // and runs at every `createAgentSession` site — see that function
  // for the runtime semantics. This route pair is just the operator
  // interface.
  // Cascade view: every per-project tool override across every
  // project, used by the Tools/MCP tabs' "+ Add override for…"
  // affordance. Mirrors the skills cascade endpoint at
  // /config/skills/overrides — same shape, same posture (single
  // small JSON file, one fetch per tab open is fine).
  fastify.get(
    "/config/tools/overrides",
    {
      schema: {
        description:
          "All per-project tool overrides across all projects. Returns " +
          "`{ projects: { <projectId>: { builtin: { enable, disable }, " +
          "mcp: { enable, disable }, extension: { enable, disable } } } }`. " +
          "Absent project keys mean 'no overrides defined' (the project " +
          "inherits from global).",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["projects"],
            properties: {
              projects: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  required: ["builtin", "mcp", "extension"],
                  properties: {
                    builtin: {
                      type: "object",
                      required: ["enable", "disable"],
                      properties: {
                        enable: { type: "array", items: { type: "string" } },
                        disable: { type: "array", items: { type: "string" } },
                      },
                    },
                    mcp: {
                      type: "object",
                      required: ["enable", "disable"],
                      properties: {
                        enable: { type: "array", items: { type: "string" } },
                        disable: { type: "array", items: { type: "string" } },
                      },
                    },
                    extension: {
                      type: "object",
                      required: ["enable", "disable"],
                      properties: {
                        enable: { type: "array", items: { type: "string" } },
                        disable: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        return await getAllToolOverrides();
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.get<{ Querystring: { projectId?: string } }>(
    "/config/tools",
    {
      schema: {
        description:
          "List every tool the agent could see, with its current " +
          "enable/disable state. Three families: `builtin` (pi's " +
          "shipped coding tools — read, bash, edit, write, grep, " +
          "find, ls), `mcp` (one entry per connected MCP server, " +
          "each with its tool list), and `extension` (one entry " +
          "per pi extension that registers tools, grouped by the " +
          "extension's path). When `?projectId=` is provided, " +
          "project-scoped MCP servers are included alongside global " +
          "ones; the project-scope server-name shadowing rule from " +
          "`mcp/manager.customToolsForProject` applies. Tool changes " +
          "apply on the NEXT session created — live sessions keep " +
          "the tool set they booted with.",
        tags: ["config"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["builtin", "mcp", "extension"],
            properties: {
              builtin: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "description", "enabled", "globalEnabled"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    /** Effective state for the active project (or
                     *  global state when no projectId given). */
                    enabled: { type: "boolean" },
                    /** Underlying global state, regardless of any
                     *  project override. The UI uses this to render
                     *  the "Global: enabled" badge alongside the
                     *  per-project tri-state. */
                    globalEnabled: { type: "boolean" },
                    /** Tri-state per-project override (absent = inherit). */
                    projectOverride: { type: "string", enum: ["enabled", "disabled"] },
                  },
                },
              },
              mcp: {
                type: "array",
                items: {
                  type: "object",
                  required: ["server", "scope", "enabled", "state", "tools"],
                  properties: {
                    server: { type: "string" },
                    scope: { type: "string", enum: ["global", "project"] },
                    projectId: { type: "string" },
                    enabled: { type: "boolean" },
                    state: { type: "string" },
                    lastError: { type: "string" },
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["name", "shortName", "description", "enabled", "globalEnabled"],
                        properties: {
                          name: { type: "string" },
                          shortName: { type: "string" },
                          description: { type: "string" },
                          enabled: { type: "boolean" },
                          globalEnabled: { type: "boolean" },
                          projectOverride: { type: "string", enum: ["enabled", "disabled"] },
                        },
                      },
                    },
                  },
                },
              },
              extension: {
                type: "array",
                items: {
                  type: "object",
                  required: ["packageSource", "tools"],
                  properties: {
                    /** Package identifier ("pi-subagents", git URL, etc.) — sourced from
                     *  ResolvedResource.metadata.source. The user-facing name. */
                    packageSource: { type: "string" },
                    tools: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["name", "description", "enabled", "globalEnabled"],
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          enabled: { type: "boolean" },
                          globalEnabled: { type: "boolean" },
                          projectOverride: { type: "string", enum: ["enabled", "disabled"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const overrides = await readToolOverrides();
        const builtinDisabled = new Set(overrides.builtin);
        const mcpDisabled = new Set(overrides.mcp);
        const extensionDisabled = new Set(overrides.extension);
        const projectId =
          typeof req.query.projectId === "string" && req.query.projectId.length > 0
            ? req.query.projectId
            : undefined;

        // Project-scope MCP servers are loaded lazily; trigger a load
        // before reading status so a fresh-after-restart UI fetch
        // doesn't show an empty MCP list for a previously-configured
        // project. Best-effort — load failures shouldn't 500 the
        // whole tool listing.
        let projectWorkspacePath: string | undefined;
        if (projectId !== undefined) {
          const project = await getProject(projectId);
          if (project !== undefined) {
            projectWorkspacePath = project.path;
            await mcpEnsureProjectLoaded(project.id, project.path).catch(() => undefined);
          }
        }

        const mcpServers = mcpGetStatus(projectId !== undefined ? { projectId } : undefined);

        // Enumerate pi extensions visible to the project's cwd
        // (or process.cwd as the fallback when no project is
        // selected — same behavior as the agent's discovery on a
        // fresh session). Extension discovery is best-effort: a
        // bad extension manifest must not 500 the whole tools
        // listing.
        const extResources = await discoverExtensionResources(
          projectWorkspacePath ?? process.cwd(),
        );
        // Group tools by package source (e.g. "pi-subagents") for
        // the Settings UI. The package name comes from the resolved
        // ResolvedResource.metadata.source, which is the user-facing
        // npm/git identifier — much friendlier than the extension's
        // entry-file path.
        const extensionGroups = new Map<string, typeof extResources.tools>();
        for (const t of extResources.tools) {
          const existing = extensionGroups.get(t.packageSource);
          if (existing === undefined) {
            extensionGroups.set(t.packageSource, [t]);
          } else {
            existing.push(t);
          }
        }

        return {
          builtin: BUILTIN_TOOL_NAMES.map((name) => {
            const globalEnabled = !builtinDisabled.has(name);
            const out: {
              name: string;
              description: string;
              enabled: boolean;
              globalEnabled: boolean;
              projectOverride?: "enabled" | "disabled";
            } = {
              name,
              description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? "",
              enabled: isToolEffective(overrides, projectId, "builtin", name),
              globalEnabled,
            };
            if (projectId !== undefined) {
              const ov = getProjectToolState(overrides, projectId, "builtin", name);
              if (ov !== undefined) out.projectOverride = ov;
            }
            return out;
          }),
          mcp: mcpServers.map((s) => {
            const out: {
              server: string;
              scope: "global" | "project";
              projectId?: string;
              enabled: boolean;
              state: string;
              lastError?: string;
              tools: {
                name: string;
                shortName: string;
                description: string;
                enabled: boolean;
                globalEnabled: boolean;
                projectOverride?: "enabled" | "disabled";
              }[];
            } = {
              server: s.name,
              scope: s.scope,
              enabled: s.enabled,
              state: s.state,
              tools: s.tools.map((t) => {
                const tOut: {
                  name: string;
                  shortName: string;
                  description: string;
                  enabled: boolean;
                  globalEnabled: boolean;
                  projectOverride?: "enabled" | "disabled";
                } = {
                  name: t.name,
                  shortName: t.shortName,
                  description: t.description,
                  enabled: isToolEffective(overrides, projectId, "mcp", t.name),
                  globalEnabled: !mcpDisabled.has(t.name),
                };
                if (projectId !== undefined) {
                  const ov = getProjectToolState(overrides, projectId, "mcp", t.name);
                  if (ov !== undefined) tOut.projectOverride = ov;
                }
                return tOut;
              }),
            };
            if (s.projectId !== undefined) out.projectId = s.projectId;
            if (s.lastError !== undefined) out.lastError = s.lastError;
            return out;
          }),
          extension: Array.from(extensionGroups.entries()).map(([packageSource, tools]) => ({
            packageSource,
            tools: tools.map((t) => {
              const tOut: {
                name: string;
                description: string;
                enabled: boolean;
                globalEnabled: boolean;
                projectOverride?: "enabled" | "disabled";
              } = {
                name: t.name,
                description: t.description ?? "",
                enabled: isToolEffective(overrides, projectId, "extension", t.name),
                globalEnabled: !extensionDisabled.has(t.name),
              };
              if (projectId !== undefined) {
                const ov = getProjectToolState(overrides, projectId, "extension", t.name);
                if (ov !== undefined) tOut.projectOverride = ov;
              }
              return tOut;
            }),
          })),
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  fastify.put<{
    Params: { family: ToolFamily; name: string };
    Querystring: { projectId?: string };
    Body: { enabled: boolean; scope?: "global" | "project" };
  }>(
    "/config/tools/:family/:name/enabled",
    {
      schema: {
        description:
          "Toggle a single tool by family + name. Family is `builtin` " +
          "(short bare name like `bash`) or `mcp` (bridged name like " +
          "`<server>__<tool>` — same name pi sees on the wire). " +
          'Default `scope: "global"` toggles the tool\'s GLOBAL state — ' +
          'absence in the disabled set means enabled. `scope: "project"` ' +
          "(requires `?projectId=`) writes a tri-state per-project " +
          "override that wins over global: `enabled: true` adds an " +
          "explicit project-enable, `enabled: false` adds a project- " +
          "disable. Clear a project override (= inherit global) via " +
          "`DELETE` on the same path with `?projectId=`. " +
          "All toggles apply on the NEXT session created; live sessions " +
          "are unaffected.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["family", "name"],
          properties: {
            family: { type: "string", enum: ["builtin", "mcp", "extension"] },
            name: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            scope: { type: "string", enum: ["global", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["family", "name", "enabled", "scope"],
            properties: {
              family: { type: "string" },
              name: { type: "string" },
              enabled: { type: "boolean" },
              scope: { type: "string", enum: ["global", "project"] },
              projectId: { type: "string" },
            },
          },
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const scope = req.body.scope ?? "global";
        if (scope === "project") {
          const projectId = req.query.projectId;
          if (typeof projectId !== "string" || projectId.length === 0) {
            return reply.code(400).send({ error: "missing_project_id" });
          }
          // Validate project exists so a typo'd id can't pollute the
          // overrides file with garbage that never resolves to anything.
          const project = await getProject(projectId);
          if (project === undefined) {
            return reply.code(404).send({ error: "project_not_found" });
          }
          const state: ToolOverrideState = req.body.enabled ? "enabled" : "disabled";
          await setProjectToolOverride(projectId, req.params.family, req.params.name, state);
          return {
            family: req.params.family,
            name: req.params.name,
            enabled: req.body.enabled,
            scope,
            projectId,
          };
        }
        await setToolEnabled(req.params.family, req.params.name, req.body.enabled);
        return {
          family: req.params.family,
          name: req.params.name,
          enabled: req.body.enabled,
          scope,
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // Clear a per-project tool override (= return that project to
  // inheriting the global default). Mirrors the skills DELETE
  // endpoint's shape.
  fastify.delete<{
    Params: { family: ToolFamily; name: string };
    Querystring: { projectId: string };
  }>(
    "/config/tools/:family/:name/enabled",
    {
      schema: {
        description:
          "Clear a per-project tool override so the project inherits " +
          "the global state. `?projectId=` is required. Idempotent — " +
          "no-op if no override exists. Returns 404 if the project " +
          "doesn't exist.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["family", "name"],
          properties: {
            family: { type: "string", enum: ["builtin", "mcp", "extension"] },
            name: { type: "string", minLength: 1 },
          },
        },
        querystring: {
          type: "object",
          required: ["projectId"],
          properties: { projectId: { type: "string", minLength: 1 } },
        },
        response: {
          200: {
            type: "object",
            required: ["family", "name", "projectId"],
            properties: {
              family: { type: "string" },
              name: { type: "string" },
              projectId: { type: "string" },
            },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const project = await getProject(req.query.projectId);
        if (project === undefined) {
          return reply.code(404).send({ error: "project_not_found" });
        }
        await setProjectToolOverride(
          req.query.projectId,
          req.params.family,
          req.params.name,
          undefined,
        );
        return {
          family: req.params.family,
          name: req.params.name,
          projectId: req.query.projectId,
        };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  // ---------------------- runtime reload ----------------------
  // Expose pi's native /reload to the browser: reload the agent runtime of
  // every live session so config changes (settings.json, providers, auth,
  // extensions, skills, prompts, themes, context files) take effect without
  // creating a new session. Semantics match `AgentSession.reload()` — NOT a
  // pi-forge process restart, and mcp.json is NOT re-read here (MCP config
  // is applied live on save via mcp/manager.reloadGlobal). In-flight agent
  // runs are aborted as part of each session's reload.
  fastify.post(
    "/config/reload",
    {
      schema: {
        description:
          "Reload the agent runtime of every live session with pi native reload semantics " +
          "(equivalent to pi TUI /reload): re-reads `settings.json`, refreshes API " +
          "providers/credentials, reloads the resource loader (extensions, skills, prompts, " +
          "themes, context files) and rebuilds the tool registry. Custom tools (MCP-bridged, " +
          "ask/todo/process, orchestration) are preserved; in-flight agent runs are aborted. " +
          "Does NOT re-read `mcp.json` (MCP config applies live on save) and does NOT restart " +
          "the pi-forge process. Responds 200 with `{ reloaded, failures }`; 500 `agent_error` " +
          "when every live session failed to reload.",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["reloaded", "failures"],
            properties: {
              reloaded: { type: "integer" },
              failures: {
                type: "array",
                items: {
                  type: "object",
                  required: ["sessionId", "error"],
                  properties: {
                    sessionId: { type: "string" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      try {
        const { reloaded, failures } = await reloadAllLiveSessions();
        if (failures.length > 0 && reloaded === 0) {
          return reply.code(500).send({
            error: "agent_error",
            message: failures.map((f) => `${f.sessionId}: ${f.error}`).join("; "),
          });
        }
        return { reloaded, failures };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  /**
   * List installed pi packages with their contributed resources
   * (tools / skills / prompts / themes) and package.json metadata.
   */
  fastify.get(
    "/config/extensions",
    {
      schema: {
        tags: ["config"],
        response: {
          200: {
            type: "object",
            properties: {
              packages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    source: { type: "string" },
                    type: { type: "string", enum: ["npm", "git", "local"] },
                    scope: { type: "string", enum: ["user", "project"] },
                    installedPath: { type: "string" },
                    name: { type: "string" },
                    version: { type: "string" },
                    description: { type: "string" },
                    resources: {
                      type: "object",
                      properties: {
                        tools: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              name: { type: "string" },
                              description: { type: "string" },
                            },
                          },
                        },
                        skills: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: { path: { type: "string" } },
                          },
                        },
                        prompts: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: { path: { type: "string" } },
                          },
                        },
                        themes: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: { path: { type: "string" } },
                          },
                        },
                      },
                    },
                    errors: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { path: { type: "string" }, error: { type: "string" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      try {
        return await listPackages(config.workspacePath, config.piConfigDir);
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  /**
   * Install a pi package (npm spec / git URL / local path) and persist
   * it in `settings.json#packages[]`. Takes effect on NEW sessions;
   * running sessions are restarted manually (Settings → General).
   */
  fastify.post(
    "/config/extensions/install",
    {
      schema: {
        tags: ["config"],
        body: {
          type: "object",
          required: ["source", "scope"],
          properties: {
            source: { type: "string", minLength: 1 },
            scope: { type: "string", enum: ["user", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { source: { type: "string" }, scope: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const { source, scope } = req.body as { source: string; scope: "user" | "project" };
      try {
        const installed = await installPackage(
          config.workspacePath,
          config.piConfigDir,
          source,
          scope,
        );
        // Newly installed package may register settings — refresh the
        // plugin-config registry in the background.
        void refreshPluginConfigs();
        return installed;
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  /**
   * Uninstall a pi package and drop its `settings.json#packages[]`
   * entry. Unknown sources → 404 `package_not_found`.
   */
  fastify.post(
    "/config/extensions/remove",
    {
      schema: {
        tags: ["config"],
        body: {
          type: "object",
          required: ["source", "scope"],
          properties: {
            source: { type: "string", minLength: 1 },
            scope: { type: "string", enum: ["user", "project"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { removed: { type: "boolean" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { source, scope } = req.body as { source: string; scope: "user" | "project" };
      try {
        const { removed } = await removePackage(
          config.workspacePath,
          config.piConfigDir,
          source,
          scope,
        );
        if (!removed) {
          return reply.code(404).send({
            error: "package_not_found",
            message: `Package "${source}" is not installed.`,
          });
        }
        // Removed package may have contributed settings — refresh the
        // plugin-config registry in the background.
        void refreshPluginConfigs();
        return { removed: true };
      } catch (err) {
        return internalError(reply, err);
      }
    },
  );

  /**
   * Build a PluginConfigSummary from a declaration + file read state.
   * Optional `description` is assigned conditionally to satisfy
   * `exactOptionalPropertyTypes` (no explicit `undefined` on optionals).
   */
  function pluginConfigSummary(
    d: {
      package: string;
      label: string;
      description?: string;
      file: string;
      source: "extension-event" | "compat";
      fields: import("../plugin-config/types.js").FieldDefinition[];
    },
    ready: boolean,
    res: {
      exists: boolean;
      error?: "invalid_json";
      values: Record<string, unknown>;
      rawValue?: unknown;
    },
    includeRaw = false,
  ): PluginConfigSummary {
    const out: PluginConfigSummary = {
      package: d.package,
      label: d.label,
      file: d.file,
      source: d.source,
      exists: res.exists,
      ready,
      fields: d.fields,
      values: res.values,
    };
    if (d.description !== undefined) out.description = d.description;
    if (includeRaw && res.rawValue !== undefined) out.rawValue = res.rawValue;
    return out;
  }

  /**
   * List plugin config declarations with per-declaration values read
   * from their config file (missing file → exists:false; invalid JSON
   * → exists:true + empty values). The list reflects the current
   * registry snapshot — capture runs in the background, so `ready`
   * may still be false while declarations are being collected.
   */
  fastify.get(
    "/config/plugin-configs",
    {
      schema: {
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["ready", "declarations", "errors"],
            properties: {
              ready: { type: "boolean" },
              declarations: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  required: ["path", "error"],
                  properties: {
                    path: { type: "string" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
          500: errorSchema,
        },
      },
    },
    async (_req, reply) => {
      const st = getPluginConfigState();
      const declarations: PluginConfigSummary[] = [];
      for (const d of st.declarations) {
        const res = await readDeclarationValues(d.file, config.piConfigDir, d.fields);
        declarations.push(pluginConfigSummary(d, st.ready, res));
      }
      const body: PluginConfigListResponse = {
        ready: st.ready,
        declarations,
        errors: st.errors,
      };
      return reply.send(body);
    },
  );

  /** Single declaration summary; unknown package → 404 `not_found`. */
  fastify.get(
    "/config/plugin-configs/:package",
    {
      schema: {
        tags: ["config"],
        params: {
          type: "object",
          required: ["package"],
          properties: { package: { type: "string" } },
        },
        response: { 404: errorSchema },
      },
    },
    async (req, reply) => {
      const { package: pkg } = req.params as { package: string };
      const d = getConfigDeclaration(pkg);
      if (d === undefined) return reply.code(404).send({ error: "not_found" });
      const st = getPluginConfigState();
      const res = await readDeclarationValues(d.file, config.piConfigDir, d.fields);
      return reply.send(pluginConfigSummary(d, st.ready, res, true));
    },
  );

  /**
   * Save a plugin config: `{ values }` writes declared field paths
   * (string-coerced for `settings-extensions.json`, matching pi's
   * `getSetting` semantics) or `{ raw }` atomically replaces the whole
   * file. `values` and `raw` are mutually exclusive.
   */
  fastify.put(
    "/config/plugin-configs/:package",
    {
      schema: {
        tags: ["config"],
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            values: { type: "object", additionalProperties: true },
            raw: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { package: pkg } = req.params as { package: string };
      const d = getConfigDeclaration(pkg);
      if (d === undefined) return reply.code(404).send({ error: "not_found" });
      const body = req.body as SavePluginConfigBody;
      if (body.values !== undefined && body.raw !== undefined) {
        return reply.code(400).send({
          error: "validation_failed",
          message: "provide either values or raw, not both",
        });
      }
      try {
        if (body.raw !== undefined) {
          await putRaw(d.file, config.piConfigDir, body.raw);
        } else {
          const values = body.values ?? {};
          const check = validateValues(d.fields, values);
          if (!check.ok) {
            return reply.code(400).send({
              error: "validation_failed",
              message: check.error,
              field: check.field,
            });
          }
          const stringCoerce = d.file === SETTINGS_EXTENSIONS_FILE;
          await putValues(d.file, config.piConfigDir, values, { stringCoerce });
        }
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof ConfigFileError) {
          if (err.code === "traversal") {
            return reply.code(403).send({ error: "traversal", message: err.message });
          }
          if (err.code === "invalid_json" || err.code === "validation") {
            return reply.code(400).send({ error: err.code, message: err.message });
          }
        }
        return reply.code(500).send({ error: "agent_error", message: (err as Error).message });
      }
    },
  );

  /** Fire-and-forget registry refresh (capture re-runs in background). */
  fastify.post(
    "/config/plugin-configs/reload",
    {
      schema: {
        tags: ["config"],
        response: {
          200: { type: "object", properties: { reloaded: { type: "boolean" } } },
        },
      },
    },
    async (_req, reply) => {
      void refreshPluginConfigs();
      return reply.send({ reloaded: true });
    },
  );
};

/**
 * One-line user-facing description per built-in tool. Kept here
 * (not in pi's SDK metadata) because we want operator-friendly
 * copy that explains the tool's PURPOSE for an audit-style view,
 * not the LLM-facing prompt snippet the SDK ships. Update if pi
 * adds new builtins to `ToolName`.
 */
const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "Read file contents from the project tree.",
  bash: "Run shell commands in the project directory.",
  edit: "Apply a search/replace edit to a file (produces a unified diff).",
  write: "Create or overwrite a file with new content.",
  grep: "Search file contents with a regex (ripgrep-backed).",
  find: "Find files by path glob.",
  ls: "List directory entries.",
  ask_user_question:
    "Surface a structured multi-choice questionnaire in the browser when the agent " +
    "needs to clarify ambiguous instructions. Implemented in pi-forge (contract-" +
    "compatible with @juicesharp/rpiv-ask-user-question).",
  todo:
    "Manage a session-scoped task list with status (pending / in_progress / completed " +
    "/ deleted), descriptions, and blockedBy dependencies. State survives reload and " +
    "compaction via branch replay. Implemented in pi-forge (contract-compatible with " +
    "@juicesharp/rpiv-todo).",
  process:
    "Manage background processes the agent spawns (dev servers, watchers, builds). " +
    "Separate from bash: lifecycle tracked, stdout/stderr captured to log files, " +
    "regex log-watches and exit-alert flags trigger agent notifications. State is " +
    "in-memory per session; killed on session dispose. Implemented in pi-forge " +
    "(contract-compatible with @aliou/pi-processes).",
};
