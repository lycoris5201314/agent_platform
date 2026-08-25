import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../core/config.js";
import type { RequestIdentity, TenantRole } from "../core/types.js";

const roleRank: Record<TenantRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export class IdentityService {
  constructor(private readonly config: AppConfig) {}

  resolve(request: FastifyRequest): RequestIdentity {
    if (this.config.auth.mode === "local") return { tenantId: "local", userId: "local-user", role: "owner" };
    const authorization = request.headers.authorization ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!this.config.auth.token) throw new Error("Unauthorized");
    if (safeEqual(supplied, this.config.auth.token)) return { tenantId: "local", userId: "token-owner", role: "owner" };
    const parts = supplied.split(".");
    if (parts.length !== 2) throw new Error("Unauthorized");
    const expected = createHmac("sha256", this.config.auth.token).update(parts[0]).digest("base64url");
    if (!safeEqual(parts[1], expected)) throw new Error("Unauthorized");
    let payload: { tenantId?: string; userId?: string; role?: string; exp?: number };
    try { payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as typeof payload; } catch { throw new Error("Unauthorized"); }
    if (!payload.tenantId || !payload.userId || (payload.exp && payload.exp < Math.floor(Date.now() / 1000))) throw new Error("Unauthorized");
    return { tenantId: payload.tenantId, userId: payload.userId, role: asRole(payload.role ?? "member") };
  }

  require(identity: RequestIdentity, minimum: TenantRole): void {
    if (roleRank[identity.role] < roleRank[minimum]) throw new Error(`Forbidden: ${minimum} role required`);
  }
}

function asRole(value: string): TenantRole {
  return value === "owner" || value === "admin" || value === "viewer" ? value : "member";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
