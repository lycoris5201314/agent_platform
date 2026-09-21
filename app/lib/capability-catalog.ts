export type CapabilityError = { section: string; message: string };
export type CapabilitySkill = { name: string; description: string; path: string; scope: string; enabled: boolean; pluginId: string | null };
export type CapabilityMcpServer = { name: string; status: "connected" | "degraded" | "unavailable"; toolCount: number; authStatus: string; pluginId: string | null; error: string | null };
export type CapabilityCatalog = {
  healthy: boolean;
  features: { namespaceTools: boolean; imageGeneration: boolean; webSearch: boolean };
  skills: CapabilitySkill[];
  mcpServers: CapabilityMcpServer[];
  permissionProfiles: string[];
  collaborationModes: string[];
  errors: CapabilityError[];
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function data(value: unknown): unknown[] {
  const section = record(value);
  return Array.isArray(section.data) ? section.data : [];
}

function compact(value: unknown, max = 500): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function normalizeCapabilityCatalog(value: unknown): CapabilityCatalog {
  const catalog = record(value);
  const errors: CapabilityError[] = [];
  for (const section of ["models", "providerCapabilities", "skills", "mcp", "permissionProfiles", "collaborationModes"]) {
    const message = record(catalog[section]).error;
    if (message) errors.push({ section, message: compact(message) });
  }

  const capabilities = record(catalog.providerCapabilities);
  const skills = data(catalog.skills).flatMap((group) => {
    const items = record(group).skills;
    return Array.isArray(items) ? items : [];
  }).map((item) => {
    const skill = record(item);
    return {
      name: compact(skill.name, 120), description: compact(skill.description, 280), path: String(skill.path ?? ""),
      scope: compact(skill.scope, 40) || "unknown", enabled: skill.enabled !== false,
      pluginId: skill.pluginId ? compact(skill.pluginId, 120) : null,
    };
  }).filter((skill) => skill.name && skill.path);

  const mcpServers = data(catalog.mcp).map((item) => {
    const server = record(item);
    const tools = record(server.tools);
    const toolsError = compact(server.toolsError);
    const runtime = compact(server.runtimeStatus, 120).toLowerCase();
    const authStatus = compact(server.authStatus, 80) || "unknown";
    const degraded = authStatus === "notLoggedIn" || /starting|connecting|auth/.test(runtime);
    const unavailable = !degraded && (Boolean(toolsError) || /failed|error|unavailable|stopped/.test(runtime));
    return {
      name: compact(server.name, 120) || "未命名 MCP", status: unavailable ? "unavailable" as const : degraded ? "degraded" as const : "connected" as const,
      toolCount: Object.keys(tools).length, authStatus,
      pluginId: server.pluginId ? compact(server.pluginId, 120) : null, error: toolsError || null,
    };
  });

  return {
    healthy: errors.length === 0,
    features: { namespaceTools: capabilities.namespaceTools === true, imageGeneration: capabilities.imageGeneration === true, webSearch: capabilities.webSearch === true },
    skills,
    mcpServers,
    permissionProfiles: data(catalog.permissionProfiles).map((item) => compact(record(item).id, 80)).filter(Boolean),
    collaborationModes: data(catalog.collaborationModes).map((item) => compact(record(item).name ?? record(item).mode, 80)).filter(Boolean),
    errors,
  };
}
