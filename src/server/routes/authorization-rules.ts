import { grantInputFromBody } from "./authorization-rule-input";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { DrizzleDB } from "@/data";

import type {
  AuthorizationSubjectType,
  OperationGrantEffect,
} from "../policy/authorization-subject";
import {
  AuthorizationRuleStore,
  type AuthorizationRuleInput,
} from "../policy/authorization-rule-store";
import { requireAdminMiddleware } from "../auth/guards";
import { getKernel } from "./kernel";
import { validateOperationGrantTarget } from "./groups";

export interface OperationGrantsRouteOptions {
  readonly db?: DrizzleDB;
}

export function createOperationGrantsRoutes(
  options: OperationGrantsRouteOptions = {},
) {
  const getDb = () => options.db ?? getKernel().database.db;

  return new Hono()
    .use("*", requireAdminMiddleware())
    .get("/", (c) => {
      const db = getDb();
      return c.json({
        status: "ok",
        grants: new AuthorizationRuleStore(db, {kind: "platform"}).listGrants({
          ...optionalSubjectType(c.req.query("subjectType")),
          ...optionalString("subjectId", c.req.query("subjectId")),
        }),
      });
    })
    .post("/", async (c) => {
      const db = getDb();
      const body = await readBody(c.req.raw);
      const input = grantInputFromBody(body);
      const target = validateOperationGrantTarget({
        db,
        subjectType: input.subjectType,
        target: input.matchType === "prefix" ? `${input.target.replace(/\.\*$/, "")}.*` : input.target,
      });
      if (target.status === "error") {
        return c.json(target, 400);
      }
      const store = new AuthorizationRuleStore(db, {kind: "platform"});
      const grant = store.addGrant(input);
      return c.json({ status: "ok", grant });
    })
    .post("/batch", async (c) => {
      const db = getDb();
      const body = await readBody(c.req.raw);
      const items = Array.isArray(body.items) ? body.items : null;
      if (items === null) {
        return c.json(
          {
            status: "error",
            code: "invalid_request",
            message: "items must be an array",
          },
          400,
        );
      }
      const inputs = items.map((item, index) =>
        grantInputFromBody(
          isRecord(item) ? item : {},
          `items[${index}]`,
        )
      );
      for (const input of inputs) {
        const target = validateOperationGrantTarget({
          db,
          subjectType: input.subjectType,
          target: input.matchType === "prefix" ? `${input.target.replace(/\.\*$/, "")}.*` : input.target,
        });
        if (target.status === "error") {
          return c.json(target, 400);
        }
      }
      try {
        const grants = new AuthorizationRuleStore(db, {kind: "platform"}).addGrants(inputs);
        return c.json({ status: "ok", grants });
      } catch (error) {
        return c.json(
          {
            status: "error",
            code: "invalid_grant",
            message: error instanceof Error ? error.message : "Invalid grant",
          },
          400,
        );
      }
    })
    .delete("/:id", (c) => {
      const grant = new AuthorizationRuleStore(getDb(), {kind: "platform"}).deleteGrant(
        c.req.param("id"),
      );
      if (grant === null) {
        return c.json(
          {
            status: "error",
            code: "not_found",
            message: `Operation grant not found: ${c.req.param("id")}`,
          },
          404,
        );
      }
      return c.json({ status: "ok", grant });
    });
}

export const authorizationRulesRoutes = createOperationGrantsRoutes();

function optionalSubjectType(
  value: string | undefined,
): { readonly subjectType: AuthorizationSubjectType } | Record<string, never> {
  if (value === undefined || value.trim() === "") {
    return {};
  }
  return { subjectType: parseSubjectType(value) };
}

function optionalString<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Record<TKey, string> | Record<string, never> {
  const parsed = stringValue(value);
  return parsed === undefined ? {} : { [key]: parsed } as Record<TKey, string>;
}

function parseSubjectType(value: unknown): AuthorizationSubjectType {
  if (value === "user" || value === "group") {
    return value;
  }
  throw new HTTPException(400, {
    message: "subjectType must be user or group",
  });
}

function parseGrantEffect(value: unknown): OperationGrantEffect {
  if (value === "allow" || value === "deny") {
    return value;
  }
  throw new HTTPException(400, {
    message: "effect must be allow or deny",
  });
}


async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function requiredString(value: unknown, name: string): string {
  const parsed = stringValue(value);
  if (parsed === undefined) {
    throw new HTTPException(400, { message: `${name} is required` });
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
