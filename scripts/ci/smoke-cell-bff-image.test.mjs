import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import test from "node:test";
import { parseArguments, runCellBffImageSmoke, smokeConfiguration } from "./smoke-cell-bff-image.mjs";

const EXPECTED = {
  platform: ["platform-admin-bff", 8098],
  nova: ["nova-bff", 8095],
  lumen: ["lumen-bff", 8096],
  pulso: ["pulso-bff", 8097]
};

test("defines a no-persisted-secret runtime contract for every cell BFF", () => {
  for (const [cell, [service, port]] of Object.entries(EXPECTED)) {
    const configuration = smokeConfiguration(cell);
    assert.equal(configuration.service, service);
    assert.equal(configuration.expectedService, service);
    assert.equal(configuration.containerPort, port);
    assert.equal(configuration.environment.PORT, String(port));
    assert.equal(configuration.environment.ACCESS_TOKEN_AUDIENCE, service);
    assert.equal(
      new URL(configuration.environment.ACCESS_JWKS_URL).hostname,
      cell === "platform" ? "access.invalid" : "identity-service"
    );
    assert.equal(configuration.environment.ACCESS_JWKS_ALLOW_PRIVATE_HTTP, cell === "platform" ? "false" : "true");
    assert.deepEqual(configuration.probePaths, cell === "platform" ? ["/health"] : ["/health", "/ready"]);
    assert.deepEqual(
      Object.keys(configuration.environment).filter((name) => /TOKEN$|SECRET|PASSWORD|ASSERTION_KEY/.test(name)),
      []
    );
  }
});

test("uses liveness-only smoke for Platform and isolated fixture origins for product BFFs", () => {
  const platform = smokeConfiguration("platform");
  assert.deepEqual(platform.probePaths, ["/health"]);
  assert.equal("IDENTITY_SERVICE_URL" in platform.environment, false);
  assert.equal("TENANT_SERVICE_URL" in platform.environment, false);

  const nova = smokeConfiguration("nova");
  assert.deepEqual(nova.productFixture.requiredDependencies, [
    "nova-core",
    "nova-voice",
    "nova-liwa",
    "nova-documents"
  ]);
  assert.equal(nova.environment.NOVA_CORE_SERVICE_URL, "http://nova-core-service:18080");
  assert.equal("NOVA_PROVIDER_EDGE_TOKEN" in nova.environment, false);

  const lumen = smokeConfiguration("lumen");
  assert.deepEqual(lumen.productFixture.requiredDependencies, ["lumen"]);
  assert.equal(lumen.environment.ACCESS_SERVICE_URL, "http://access-service:18080");
  assert.equal(lumen.environment.LUMEN_SERVICE_URL, "http://lumen-service:18080");
  const pulso = smokeConfiguration("pulso");
  assert.deepEqual(pulso.productFixture.requiredDependencies, ["pulso-core", "pulso-integration"]);
  for (const name of [
    "ACCESS_SERVICE_URL",
    "PULSO_IRIS_SERVICE_URL",
    "AGENT_SERVICE_URL",
    "PROMPT_FLOW_SERVICE_URL",
    "KNOWLEDGE_SERVICE_URL",
    "INTEGRATION_SERVICE_URL",
    "WHATSAPP_CHANNEL_SERVICE_URL"
  ]) {
    assert.match(pulso.environment[name], /^http:\/\/[a-z0-9-]+:18080$/, name);
  }
});

test("Platform image smoke never treats dependency readiness as an isolated-image contract", async () => {
  const requestedUrls = [];
  const docker = async (arguments_) => {
    if (arguments_[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (arguments_[0] === "inspect") return { stdout: "true 0\n", stderr: "" };
    if (arguments_[0] === "port") return { stdout: "127.0.0.1:49198\n", stderr: "" };
    if (arguments_[0] === "rm") return { stdout: "", stderr: "" };
    throw new Error(`unexpected Docker command ${arguments_[0]}`);
  };
  await runCellBffImageSmoke(
    { cell: "platform", image: "platform:test" },
    {
      docker,
      fetch: async (url) => {
        requestedUrls.push(url);
        return { ok: true, status: 200, json: async () => ({ service: "platform-admin-bff", status: "ok" }) };
      }
    }
  );
  assert.deepEqual(requestedUrls, ["http://127.0.0.1:49198/health"]);
});

test("Platform image smoke rejects a healthy HTTP status with the wrong service contract", async () => {
  let clock = 0;
  const docker = async (arguments_) => {
    if (arguments_[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (arguments_[0] === "inspect") return { stdout: "true 0\n", stderr: "" };
    if (arguments_[0] === "port") return { stdout: "127.0.0.1:49199\n", stderr: "" };
    if (arguments_[0] === "logs") return { stdout: "platform-admin-bff listening\n", stderr: "" };
    if (arguments_[0] === "rm") return { stdout: "", stderr: "" };
    throw new Error(`unexpected Docker command ${arguments_[0]}`);
  };
  await assert.rejects(
    runCellBffImageSmoke(
      { cell: "platform", image: "platform:test", timeoutMs: 1, pollIntervalMs: 1 },
      {
        docker,
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ service: "some-other-process", status: "ok" })
        }),
        now: () => clock,
        wait: async () => {
          clock = 2;
        }
      }
    ),
    /invalid image health contract[\s\S]*some-other-process/
  );
});

test("proves cold failure and warm provider-owned readiness for every product image on an internal network", async () => {
  for (const cell of ["nova", "lumen", "pulso"]) {
    const configuration = smokeConfiguration(cell);
    const dockerCalls = [];
    const probedPaths = [];
    let fixtureStarted = false;
    const docker = async (arguments_) => {
      dockerCalls.push(arguments_);
      if (arguments_[0] === "network" && arguments_[1] === "create") return { stdout: "network-id\n", stderr: "" };
      if (arguments_[0] === "run") {
        if (arguments_.includes("--eval")) fixtureStarted = true;
        return { stdout: "container-id\n", stderr: "" };
      }
      if (arguments_[0] === "inspect") return { stdout: "true 0\n", stderr: "" };
      if (arguments_[0] === "exec") {
        const source = arguments_.at(-1);
        const endpointPath = source.includes("/health") ? "/health" : "/ready";
        probedPaths.push(endpointPath);
        const body =
          endpointPath === "/health"
            ? { service: configuration.expectedService, status: "ok" }
            : readinessBody(configuration, fixtureStarted ? "warm" : "cold");
        return {
          stdout: JSON.stringify({
            httpStatus: endpointPath === "/health" || fixtureStarted ? 200 : 503,
            body
          }),
          stderr: ""
        };
      }
      if (arguments_[0] === "rm") return { stdout: "", stderr: "" };
      if (arguments_[0] === "network" && arguments_[1] === "rm") return { stdout: "", stderr: "" };
      throw new Error(`unexpected Docker command ${arguments_.join(" ")}`);
    };
    const result = await runCellBffImageSmoke(
      { cell, image: `sha256:${cell}` },
      {
        docker,
        fetch: async () => {
          throw new Error("product smoke must probe only inside the internal Docker network");
        }
      }
    );
    assert.match(result.baseUrl, new RegExp(`^docker-exec://hyperion-${cell}-bff-smoke-[a-f0-9-]+:`));
    assert.deepEqual(probedPaths, ["/health", "/ready", "/ready"]);

    const networkCreate = dockerCalls.find((arguments_) => arguments_[0] === "network" && arguments_[1] === "create");
    assert.ok(networkCreate.includes("--internal"));
    assert.ok(networkCreate.includes(`io.hyperion.ci.cell-bff-smoke=${cell}`));

    const bffRun = dockerCalls.find((arguments_) => arguments_[0] === "run" && !arguments_.includes("--eval"));
    const fixtureRun = dockerCalls.find((arguments_) => arguments_[0] === "run" && arguments_.includes("--eval"));
    assert.ok(bffRun);
    assert.ok(fixtureRun);
    assert.deepEqual(bffRun.slice(-3), [`sha256:${cell}`, "node", configuration.artifact]);
    assert.equal(bffRun.includes("--publish"), false);
    assert.ok(bffRun.includes("ACCESS_JWKS_URL=http://identity-service:18080/jwks"));
    assert.ok(bffRun.includes("ACCESS_JWKS_ALLOW_PRIVATE_HTTP=true"));
    assert.ok(bffRun.includes("--read-only"));
    assert.ok(bffRun.includes("no-new-privileges"));
    for (const credentialName of configuration.productFixture.credentialNames) {
      const assignment = bffRun.find((argument) => argument.startsWith(`${credentialName}=`));
      assert.match(assignment, new RegExp(`^${credentialName}=ci-[A-Za-z0-9_-]{43}$`));
    }
    assert.equal(
      bffRun.some((argument) => argument.startsWith("NOVA_PROVIDER_EDGE_TOKEN=")),
      false
    );

    assert.equal(fixtureRun.includes("--publish"), false);
    assert.ok(fixtureRun.includes(`sha256:${cell}`));
    assert.ok(fixtureRun.includes("--input-type=module"));
    const fixtureSource = fixtureRun.at(-1);
    assert.match(fixtureSource, /"kty":"RSA"/);
    assert.match(fixtureSource, /identity-service/);
    assert.match(fixtureSource, /access-service/);
    const jwkMatch = fixtureSource.match(/const jwk=(\{[^;]+\});const readyHosts=/);
    assert.ok(jwkMatch);
    const publicKey = createPublicKey({ key: JSON.parse(jwkMatch[1]), format: "jwk" });
    assert.equal(publicKey.asymmetricKeyType, "rsa");
    for (const alias of configuration.productFixture.aliases) {
      assert.ok(fixtureRun.includes(alias), alias);
    }

    const removals = dockerCalls.filter((arguments_) => arguments_[0] === "rm");
    assert.equal(removals.length, 2);
    assert.ok(removals.every((arguments_) => arguments_[1] === "--force"));
    assert.deepEqual(dockerCalls.at(-1).slice(0, 2), ["network", "rm"]);
  }
});

test("fails immediately when the BFF exits and still removes the container", async () => {
  const dockerCalls = [];
  const docker = async (arguments_) => {
    dockerCalls.push(arguments_);
    if (arguments_[0] === "network" && arguments_[1] === "create") return { stdout: "network-id\n", stderr: "" };
    if (arguments_[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (arguments_[0] === "inspect") return { stdout: "false 17\n", stderr: "" };
    if (arguments_[0] === "logs") return { stdout: "", stderr: "ACCESS_JWKS_URL is required\n" };
    if (arguments_[0] === "rm") return { stdout: "", stderr: "" };
    if (arguments_[0] === "network" && arguments_[1] === "rm") return { stdout: "", stderr: "" };
    throw new Error(`unexpected Docker command ${arguments_.join(" ")}`);
  };

  await assert.rejects(
    runCellBffImageSmoke({ cell: "lumen", image: "lumen:test" }, { docker }),
    /lumen-bff exited before readiness \(exit 17\)[\s\S]*ACCESS_JWKS_URL is required/
  );
  assert.equal(
    dockerCalls.some((arguments_) => arguments_[0] === "rm"),
    true
  );
  assert.deepEqual(dockerCalls.at(-1).slice(0, 2), ["network", "rm"]);
});

test("fails when HTTP readiness never responds and still removes the container", async () => {
  const dockerCalls = [];
  let clock = 0;
  const docker = async (arguments_) => {
    dockerCalls.push(arguments_);
    if (arguments_[0] === "network" && arguments_[1] === "create") return { stdout: "network-id\n", stderr: "" };
    if (arguments_[0] === "run") return { stdout: "container-id\n", stderr: "" };
    if (arguments_[0] === "inspect") return { stdout: "true 0\n", stderr: "" };
    if (arguments_[0] === "exec") throw new Error("connection refused");
    if (arguments_[0] === "logs") return { stdout: "listening\n", stderr: "" };
    if (arguments_[0] === "rm") return { stdout: "", stderr: "" };
    if (arguments_[0] === "network" && arguments_[1] === "rm") return { stdout: "", stderr: "" };
    throw new Error(`unexpected Docker command ${arguments_.join(" ")}`);
  };

  await assert.rejects(
    runCellBffImageSmoke(
      { cell: "pulso", image: "pulso:test", timeoutMs: 1, pollIntervalMs: 1 },
      {
        docker,
        fetch: async () => {
          throw new Error("connection refused");
        },
        now: () => clock,
        wait: async () => {
          clock = 2;
        }
      }
    ),
    /pulso-bff did not pass its isolated image health contract within 1ms:[^\n]*cannot probe \/health[^\n]*connection refused[\s\S]*listening/
  );
  assert.equal(
    dockerCalls.some((arguments_) => arguments_[0] === "rm"),
    true
  );
  assert.deepEqual(dockerCalls.at(-1).slice(0, 2), ["network", "rm"]);
});

test("rejects missing, unsafe and malformed CLI arguments", () => {
  assert.throws(() => parseArguments(["--cell", "nova"]), /--image/);
  assert.throws(() => parseArguments(["--cell", "unknown", "--image", "test"]), /Unknown cell/);
  assert.throws(() => parseArguments(["--cell", "nova", "--image", "--privileged"]), /Docker image reference/);
  assert.throws(() => parseArguments(["--cell", "nova", "--image", "test", "--timeout-ms", "0"]), /positive integer/);
});

function readinessBody(configuration, phase) {
  const requiredStatus = phase === "cold" ? "down" : "ok";
  return {
    service: configuration.expectedService,
    status: phase === "cold" ? "down" : "ok",
    dependencies: [
      { name: "access-signing-keys", status: requiredStatus, required: true },
      { name: "access-token-minting", status: "degraded", required: false },
      ...configuration.productFixture.requiredDependencies.map((name) => ({
        name,
        status: requiredStatus,
        required: true
      }))
    ]
  };
}
