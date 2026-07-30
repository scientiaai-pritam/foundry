/**
 * Contract tests for the Supabase Postgres provisioner (design v1, §8 —
 * "Contract tests per plugin ... tested against a stubbed API").
 *
 * No real Supabase calls. These pin the behaviour the orchestrator relies on:
 * correct calls on create/update/replace/destroy, polling-to-ready, idempotency
 * (read-before-create + conflict tolerance), protect-guard refusal, and
 * read-driven drift mapping. They also assert the SECURITY invariant that the
 * DB password VALUE is sent on create but NEVER appears in persisted state.
 *
 * aws-dynamodb uses aws-sdk-client-mock to intercept the SDK transport; the
 * equivalent for this non-SDK provisioner is a stubbed global `fetch` injected
 * into SupabaseManagementClient.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  SupabaseManagementClient,
  SupabasePostgresProvisioner,
  ProtectedResourceError,
  resolveSecret,
} from "../src/index.js";
import { idempotencyToken } from "@foundry/core";
import type {
  PlanAction,
  ResourceSpec,
  ResourceState,
  SecretRef,
} from "@foundry/core";

/* ------------------------------ fixtures ------------------------------ */

const FAST_WAIT = { initialIntervalMs: 1, timeoutMs: 2000 };
const TOKEN = "sbpat_testtoken_notreal";
/** POINTER to the DB password (the VALUE lives in process.env.SUPABASE_DB_PASS). */
const DB_PASS: SecretRef = { from: "env:SUPABASE_DB_PASS" };
const DB_PASS_VALUE = "hunter2-not-a-real-secret";
const REF = "abcdefghijklmnopqrst";
const ORG = "org-slug-123";

function spec(
  props: Record<string, unknown>,
  id = "appdb",
  tags?: Record<string, string>,
): ResourceSpec {
  const s: ResourceSpec = { id, kind: "supabase.postgres", props };
  if (tags) s.tags = tags;
  return s;
}

const BASE_PROPS = {
  name: "appdb",
  organizationId: ORG,
  region: "us-east-1",
  plan: "pro",
  dbPass: DB_PASS,
};

interface ProjectJson {
  id?: string;
  ref: string;
  organization_id?: string;
  name: string;
  region?: string;
  status: string;
  // `| undefined` (under exactOptionalPropertyTypes) lets call sites pass
  // `database: undefined` to model the API omitting the block at INACTIVE.
  database?: { host?: string } | undefined;
}

function project(overrides: Partial<ProjectJson> = {}): ProjectJson {
  return {
    id: "1",
    ref: REF,
    organization_id: ORG,
    name: "appdb",
    region: "us-east-1",
    status: "ACTIVE_HEALTHY",
    database: { host: `db.${REF}.supabase.co` },
    ...overrides,
  };
}

function stateFromOutputs(
  outputs: Record<string, unknown>,
  id = "appdb",
): ResourceState {
  return {
    id,
    kind: "supabase.postgres",
    identifiers: { ref: outputs.ref as string },
    status: "available",
    connection: { engine: "postgres", region: "us-east-1", credsRef: DB_PASS },
    outputs,
  };
}

/* ------------------------------- mock API ----------------------------- */

interface MockResp {
  status: number;
  body?: unknown;
}

interface CapturedCall {
  method: string;
  path: string;
  body: unknown;
  auth: string;
}

class MockApi {
  private readonly queues = new Map<string, MockResp[]>();
  readonly calls: CapturedCall[] = [];
  /** Returned when a route's queue is empty (drives poll-until-deleted via 404). */
  defaultResp: MockResp = { status: 404, body: { message: "not found" } };

  enqueue(method: string, path: string, status: number, body?: unknown): this {
    const key = `${method} ${path}`;
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    q.push({ status, body });
    return this;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    // Reduce to the /v1/... path (strip scheme + host).
    const idx = url.indexOf("/v1/");
    const path = idx >= 0 ? url.slice(idx) : new URL(url).pathname;

    let reqBody: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        reqBody = JSON.parse(init.body);
      } catch {
        reqBody = init.body;
      }
    }
    const headers = init?.headers as Record<string, string> | undefined;
    this.calls.push({ method, path, body: reqBody, auth: headers?.Authorization ?? "(none)" });

    const key = `${method} ${path}`;
    const q = this.queues.get(key);
    const resp = q && q.length > 0 ? (q.shift() as MockResp) : this.defaultResp;
    const text = resp.body !== undefined ? JSON.stringify(resp.body) : "";
    return new Response(text, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  };

  callsFor(method: string, pathPrefix: string): CapturedCall[] {
    return this.calls.filter(
      (c) => c.method === method && c.path.startsWith(pathPrefix),
    );
  }
}

let api: MockApi;

function makeProvisioner(allowProtectedDestroy = false): SupabasePostgresProvisioner {
  const client = new SupabaseManagementClient({
    tokenProvider: async () => TOKEN,
    fetch: api.fetch,
  });
  return new SupabasePostgresProvisioner({
    client,
    allowProtectedDestroy,
    waitFor: FAST_WAIT,
  });
}

beforeEach(() => {
  api = new MockApi();
  process.env.SUPABASE_DB_PASS = DB_PASS_VALUE;
});

afterEach(() => {
  delete process.env.SUPABASE_DB_PASS;
});

/* =============================== plan =============================== */

describe("plan", () => {
  it("creates when there is no current state", () => {
    const prov = makeProvisioner();
    const action = prov.plan(spec(BASE_PROPS), null);
    expect(action).toEqual({ op: "create", spec: spec(BASE_PROPS) });
  });

  it("noops when desired matches current", () => {
    const prov = makeProvisioner();
    const current = stateFromOutputs({
      name: "appdb",
      ref: REF,
      organizationId: ORG,
      region: "us-east-1",
      plan: "pro",
      protect: false,
    });
    const action = prov.plan(spec(BASE_PROPS), current);
    expect(action.op).toBe("noop");
  });

  it("reports a name change as an in-place update", () => {
    const prov = makeProvisioner();
    const current = stateFromOutputs({
      name: "appdb-old",
      ref: REF,
      organizationId: ORG,
      region: "us-east-1",
      plan: "pro",
      protect: false,
    });
    const action = prov.plan(spec(BASE_PROPS), current);
    expect(action.op).toBe("update");
    if (action.op === "update") {
      expect(action.changedFields).toContain("name");
      expect(action.changedFields).not.toContain("region");
    }
  });

  it("replaces when region changes (cannot be moved in place)", () => {
    const prov = makeProvisioner();
    const current = stateFromOutputs({
      name: "appdb",
      ref: REF,
      organizationId: ORG,
      region: "us-east-1",
      plan: "pro",
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS, region: "eu-west-1" });
    const action = prov.plan(desired, current);
    expect(action.op).toBe("replace");
    if (action.op === "replace") {
      expect(action.reason).toMatch(/region/i);
    }
  });
});

/* =============================== apply ============================== */

describe("apply (create)", () => {
  it("creates the project, polls to ACTIVE_HEALTHY, returns a postgres connection state, and NEVER persists the password", async () => {
    const prov = makeProvisioner();
    // read-before-create: no existing project by name.
    api.enqueue("GET", "/v1/projects", 200, []);
    api.enqueue("POST", "/v1/projects", 201, project({ status: "INACTIVE", database: undefined }));
    // pollUntilActive: INACTIVE once, then ACTIVE_HEALTHY (ready → stop).
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "INACTIVE" }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "ACTIVE_HEALTHY" }));
    // final read after poll.
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

    expect(state.kind).toBe("supabase.postgres");
    expect(state.status).toBe("available");
    expect(state.identifiers.ref).toBe(REF);
    expect(state.connection.engine).toBe("postgres");
    expect(state.connection.endpoint).toBe(`db.${REF}.supabase.co:5432`);
    expect(state.connection.region).toBe("us-east-1");
    // The DB password POINTER is emitted for the connector (value never stored).
    expect(state.connection.credsRef).toEqual(DB_PASS);

    // SECURITY: the password VALUE must not leak into persisted state.
    expect(JSON.stringify(state)).not.toContain(DB_PASS_VALUE);

    // The create POST carried the expected shape + the resolved password value.
    const posts = api.callsFor("POST", "/v1/projects");
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as Record<string, unknown>;
    expect(body.name).toBe("appdb");
    expect(body.organization_id).toBe(ORG);
    expect(body.region).toBe("us-east-1");
    expect(body.plan).toBe("pro");
    expect(body.db_pass).toBe(DB_PASS_VALUE);
    // Supabase has no native create idempotency token field — must not be emitted.
    expect(body.idempotency_token).toBeUndefined();
    expect(body.client_request_token).toBeUndefined();

    // The Bearer token from the tokenProvider is on every call.
    expect(posts[0]?.auth).toBe(`Bearer ${TOKEN}`);

    // The polling loop iterated (INACTIVE → ACTIVE_HEALTHY).
    expect(api.callsFor("GET", `/v1/projects/${REF}`).length).toBeGreaterThanOrEqual(2);
  });

  it("treats a healthy existing project as already-created (read-before-create idempotency)", async () => {
    const prov = makeProvisioner();
    // A project with the same name already exists and is healthy.
    api.enqueue("GET", "/v1/projects", 200, [project()]);
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

    expect(state.status).toBe("available");
    // No POST was issued — the existing project was adopted.
    expect(api.callsFor("POST", "/v1/projects")).toHaveLength(0);
  });

  it("tolerates a create conflict (409) by falling back to the existing project", async () => {
    const prov = makeProvisioner();
    // First list (read-before-create): empty.
    api.enqueue("GET", "/v1/projects", 200, []);
    api.enqueue("POST", "/v1/projects", 409, { message: "project already exists" });
    // Fallback name lookup finds the existing project.
    api.enqueue("GET", "/v1/projects", 200, [project()]);
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "INACTIVE" }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "ACTIVE_HEALTHY" }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

    const state = await prov.apply({ op: "create", spec: spec(BASE_PROPS) });
    expect(state.status).toBe("available");
  });

  it("resolves the access token via resolveSecret (token VALUE never logged)", async () => {
    process.env.SUPABASE_ACCESS_TOKEN = TOKEN;
    try {
      const client = new SupabaseManagementClient({
        tokenProvider: async () => resolveSecret({ from: "env:SUPABASE_ACCESS_TOKEN" }),
        fetch: api.fetch,
      });
      const prov = new SupabasePostgresProvisioner({ client, waitFor: FAST_WAIT });
      api.enqueue("GET", "/v1/projects", 200, []);
      api.enqueue("POST", "/v1/projects", 201, project({ status: "INACTIVE", database: undefined }));
      api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "ACTIVE_HEALTHY" }));
      api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

      await prov.apply({ op: "create", spec: spec(BASE_PROPS) });

      const posts = api.callsFor("POST", "/v1/projects");
      expect(posts[0]?.auth).toBe(`Bearer ${TOKEN}`);
      // Token value never appears in any captured request body or path.
      for (const c of api.calls) {
        // GETs carry no body (c.body === undefined → JSON.stringify yields
        // undefined, not a string); coerce so the assertion stays well-formed.
        const bodyJson = c.body === undefined ? "" : JSON.stringify(c.body);
        expect(bodyJson).not.toContain(TOKEN);
      }
    } finally {
      delete process.env.SUPABASE_ACCESS_TOKEN;
    }
  });
});

describe("apply (update)", () => {
  it("renames the project via PATCH /v1/projects/{ref}", async () => {
    const prov = makeProvisioner();
    api.enqueue("PATCH", `/v1/projects/${REF}`, 200, { id: 1, ref: REF, name: "appdb-new" });
    // pollUntilActive (ready immediately) + final read.
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ name: "appdb-new" }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ name: "appdb-new" }));

    const from = stateFromOutputs({
      name: "appdb",
      ref: REF,
      organizationId: ORG,
      region: "us-east-1",
      plan: "pro",
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS, name: "appdb-new" });
    const action: PlanAction = { op: "update", spec: desired, from, changedFields: ["name"] };

    await prov.apply(action);

    const patches = api.callsFor("PATCH", `/v1/projects/${REF}`);
    expect(patches).toHaveLength(1);
    expect((patches[0]?.body as Record<string, unknown>).name).toBe("appdb-new");
  });

  it("does not PATCH when only plan drifts (not enforceable in place)", async () => {
    const prov = makeProvisioner();
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project()); // final read only

    const from = stateFromOutputs({
      name: "appdb",
      ref: REF,
      organizationId: ORG,
      region: "us-east-1",
      plan: "free",
      protect: false,
    });
    const desired = spec({ ...BASE_PROPS }); // plan: pro
    const action: PlanAction = { op: "update", spec: desired, from, changedFields: ["plan"] };

    await prov.apply(action);
    expect(api.callsFor("PATCH", `/v1/projects/${REF}`)).toHaveLength(0);
  });
});

describe("apply (replace)", () => {
  it("deletes the existing project then recreates it", async () => {
    const prov = makeProvisioner();
    // resolveRef (replace): finds existing.
    api.enqueue("GET", "/v1/projects", 200, [project()]);
    // tryGetProject before delete.
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());
    api.enqueue("DELETE", `/v1/projects/${REF}`, 200, { id: 1, ref: REF, name: "appdb" });
    // pollUntilDeleted polls GET until it 404s — enqueue the gone-marker
    // explicitly; otherwise it would consume the recreate-phase GETs below.
    api.enqueue("GET", `/v1/projects/${REF}`, 404, { message: "not found" });
    // applyCreate: resolveRef → empty, POST, poll, read.
    api.enqueue("GET", "/v1/projects", 200, []);
    api.enqueue("POST", "/v1/projects", 201, project({ status: "INACTIVE", database: undefined }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project({ status: "ACTIVE_HEALTHY" }));
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

    const state = await prov.apply({
      op: "replace",
      spec: spec({ ...BASE_PROPS, region: "eu-west-1" }),
      reason: "region change",
    });

    expect(state.status).toBe("available");
    expect(api.callsFor("DELETE", `/v1/projects/${REF}`)).toHaveLength(1);
    expect(api.callsFor("POST", "/v1/projects")).toHaveLength(1);
  });

  it("refuses to replace a protected resource without force", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.apply({
        op: "replace",
        spec: spec({ ...BASE_PROPS, region: "eu-west-1", protect: true }),
        reason: "region change",
      }),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(api.callsFor("DELETE", "/v1/projects/")).toHaveLength(0);
  });
});

/* =============================== read ============================== */

describe("read", () => {
  it("maps a live project to a ResourceState for drift detection", async () => {
    const prov = makeProvisioner();
    api.enqueue("GET", "/v1/projects", 200, [project()]);
    api.enqueue("GET", `/v1/projects/${REF}`, 200, project());

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).not.toBeNull();
    expect(state?.status).toBe("available");
    expect(state?.outputs?.region).toBe("us-east-1");
    expect(JSON.stringify(state)).not.toContain(DB_PASS_VALUE);
  });

  it("returns null when the project does not exist", async () => {
    const prov = makeProvisioner();
    api.enqueue("GET", "/v1/projects", 200, []); // no name match → no GET by ref

    const state = await prov.read(spec(BASE_PROPS));
    expect(state).toBeNull();
  });
});

/* ============================= destroy ============================ */

describe("destroy", () => {
  it("deletes the project and is done once it 404s", async () => {
    const prov = makeProvisioner();
    api.enqueue("DELETE", `/v1/projects/${REF}`, 200, { id: 1, ref: REF, name: "appdb" });
    // pollUntilDeleted: default 404 (queue empty) → gone immediately.

    await prov.destroy(stateFromOutputs({ name: "appdb", ref: REF }));
    expect(api.callsFor("DELETE", `/v1/projects/${REF}`)).toHaveLength(1);
  });

  it("refuses a protected project without allowProtectedDestroy", async () => {
    const prov = makeProvisioner(false);
    await expect(
      prov.destroy(stateFromOutputs({ name: "appdb", ref: REF, protect: true })),
    ).rejects.toBeInstanceOf(ProtectedResourceError);
    expect(api.callsFor("DELETE", "/v1/projects/")).toHaveLength(0);
  });

  it("destroys a protected project when allowProtectedDestroy is set (force)", async () => {
    const prov = makeProvisioner(true);
    api.enqueue("DELETE", `/v1/projects/${REF}`, 200, { id: 1, ref: REF, name: "appdb" });

    await prov.destroy(stateFromOutputs({ name: "appdb", ref: REF, protect: true }));
    expect(api.callsFor("DELETE", `/v1/projects/${REF}`)).toHaveLength(1);
  });

  it("is idempotent when the project is already gone (DELETE 404)", async () => {
    const prov = makeProvisioner();
    api.enqueue("DELETE", `/v1/projects/${REF}`, 404, { message: "not found" });

    await expect(
      prov.destroy(stateFromOutputs({ name: "appdb", ref: REF })),
    ).resolves.toBeUndefined();
  });
});

/* ====================== unified idempotency token =================== */

describe("idempotency token parity", () => {
  it("derives a deterministic token from (resourceId, op) — recorded by the orchestrator, not sent to Supabase", () => {
    expect(idempotencyToken("appdb", "create")).toBe(idempotencyToken("appdb", "create"));
    expect(idempotencyToken("appdb", "create")).not.toBe(idempotencyToken("appdb", "update"));
    // Supabase create accepts no idempotency token field; the framework token
    // lives only on the orchestrator's step result (asserted implicitly above:
    // the POST body never carries idempotency_token / client_request_token).
  });
});
