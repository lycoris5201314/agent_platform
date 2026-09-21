const SERVER_LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export function resolveServerLogLevel(value: string | undefined): string {
  const requested = value?.trim().toLowerCase();
  return requested && SERVER_LOG_LEVELS.has(requested) ? requested : "warn";
}
