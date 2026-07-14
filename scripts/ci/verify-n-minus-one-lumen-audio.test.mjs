import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(join(directory, "verify-n-minus-one-lumen-audio.sh"), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section terminator: ${endMarker}`);
  return source.slice(start, end);
}

test("current LUMEN crash probe signs inside the runtime and keeps the HMAC key there", () => {
  const currentCredentials = section(script, 'if [[ $contract == "current" ]]', "runtime_temp_root=$(");
  assert.match(currentCredentials, /GATEWAY_TO_LUMEN_TOKEN/);

  const signer = section(script, 'if [[ $contract == "current" ]]; then\n  # Sign inside', "request_probe=$(");
  assert.match(signer, /compose\[@\].*exec -T lumen-service/s);
  assert.match(signer, /createOperatorAssertion/);
  assert.match(signer, /GATEWAY_OPERATOR_ASSERTION_KEY/);
  assert.match(signer, /operatorId/);
  assert.match(signer, /role: "admin"/);
  assert.match(signer, /tenantId/);
  assert.match(signer, /expiresAtUnix: Math\.floor\(Date\.now\(\) \/ 1000\) \+ 60/);

  const invocation = section(script, 'probe_container="${project_name}-lumen-audio-probe"', "request_pid=$!");
  assert.match(invocation, /printf '%s\\n%s\\n' "\$runtime_gateway_token" "\$runtime_operator_assertion"/);
  assert.match(invocation, /docker run --rm --interactive/);
  assert.doesNotMatch(invocation, /--env[^\n]*(GATEWAY_TO_LUMEN_TOKEN|GATEWAY_OPERATOR_ASSERTION_KEY)/);
  assert.doesNotMatch(invocation, /"\$runtime_(gateway_token|operator_assertion)"[^\n]*node --input-type/);
  assert.doesNotMatch(invocation, /GATEWAY_OPERATOR_ASSERTION_KEY/);
});

test("current LUMEN request forwards the short-lived assertion over stdin", () => {
  const probe = section(script, "request_probe=$(", 'probe_container="${project_name}-lumen-audio-probe"');
  assert.match(probe, /\[gatewayToken = "", operatorAssertion = ""\]/);
  assert.match(probe, /headers\["x-hyperion-operator-assertion"\]/);
  assert.match(probe, /headers\["x-hyperion-operator-assertion"\] = operatorAssertion/);
  assert.match(probe, /headers\["x-hyperion-caller"\] = "api-gateway"/);
  assert.doesNotMatch(probe, /GATEWAY_OPERATOR_ASSERTION_KEY|createHmac/);
});

test("legacy LUMEN path does not require the current assertion credentials", () => {
  const probe = section(script, "request_probe=$(", 'probe_container="${project_name}-lumen-audio-probe"');
  const currentBranch = section(probe, 'if (contract === "current")', "const response = await fetch");
  assert.match(currentBranch, /missing current LUMEN gateway credential/);
  assert.match(currentBranch, /missing current LUMEN operator assertion/);
  assert.doesNotMatch(probe.slice(0, probe.indexOf(currentBranch)), /throw new Error\("missing current LUMEN/);
});
