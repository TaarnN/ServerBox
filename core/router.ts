// File: /core/router.ts
import type { Handler } from "../types";

export interface MatchResult {
  handler: Handler;
  params: Record<string, string>;
}

type Method = "GET" | "POST" | "PUT" | "DELETE" | "USE";

interface RouteEntry {
  method: Method;
  pattern: string;
  handler: Handler;
}

export class Router {
  private routes: RouteEntry[] = [];

  add(method: Method, pattern: string, handler: Handler) {
    this.routes.push({ method, pattern, handler });
    console.log(`[Router] Added ${method} ${pattern}`);
  }

  match(method: string, path: string): MatchResult | null {
    for (const { method: m, pattern, handler } of this.routes) {
      if (m !== method && m !== "USE") continue;
      const params = this.matchPattern(pattern, path);
      if (params) {
        return { handler, params };
      }
    }
    return null;
  }

  private matchPattern(
    pattern: string,
    path: string
  ): Record<string, string> | null {
    const cleanPattern = pattern.replace(/\/+$/, "");
    const cleanPath = path.replace(/\/+$/, "");
    const patSegs = cleanPattern.split("/").filter(Boolean);
    const pathSegs = cleanPath.split("/").filter(Boolean);
    const params: Record<string, string> = {};

    let i = 0,
      j = 0;
    while (i < patSegs.length && j < pathSegs.length) {
      const p = patSegs[i];
      const seg = pathSegs[j];
      if (p === "*") {
        let wildIndex = 0;
        const rest = pathSegs.slice(j).join("/");
        params[`wild${wildIndex++}`] = rest;
        return params;
      }
      if (p!.startsWith(":")) {
        if (p!.endsWith("?")) {
          const name = p!.slice(1, -1);
          if (seg) params[name] = seg;
          i++;
          j++;
          continue;
        }
        const name = p!.slice(1);
        if (!name) return null;
        params[name] = seg!;
      } else if (p !== seg) {
        return null;
      }
      i++;
      j++;
    }

    if (i === patSegs.length && j === pathSegs.length) {
      return params;
    }
    return null;
  }
}
