import assert from "node:assert/strict";
import test from "node:test";
import {
  assertOutboundTrunkReadback,
  buildOutboundTrunkConfig,
  parseSipTrunkCodecs
} from "./elevenlabs-sip-trunk-config.mjs";

test("builds the VoipCentral-compatible ElevenLabs outbound trunk contract", () => {
  const config = buildOutboundTrunkConfig({
    address: "sip.voipcentral.net",
    username: "user",
    password: "secret",
    transport: "TCP"
  });
  assert.deepEqual(config.enabled_codecs, ["PCMA/8000", "PCMU/8000"]);
  assert.equal(config.media_encryption, "disabled");
  assert.equal(config.transport, "tcp");
});

test("deduplicates configured codecs and rejects malformed codec names", () => {
  assert.deepEqual(parseSipTrunkCodecs("PCMA/8000, PCMU/8000,PCMA/8000"), ["PCMA/8000", "PCMU/8000"]);
  assert.throws(() => parseSipTrunkCodecs("not-a-codec"), /codec\/rate/);
});

test("accepts flattened and nested provider readback", () => {
  const expected = buildOutboundTrunkConfig({
    address: "sip.voipcentral.net",
    username: "user",
    password: "secret",
    transport: "tcp"
  });
  assert.doesNotThrow(() =>
    assertOutboundTrunkReadback(
      {
        provider_config: {
          address: expected.address,
          transport: expected.transport,
          media_encryption: expected.media_encryption,
          enabled_codecs: expected.enabled_codecs
        }
      },
      expected
    )
  );
  assert.throws(
    () => assertOutboundTrunkReadback({ outbound_trunk_config: { ...expected, enabled_codecs: [] } }, expected),
    /enabled_codecs/
  );
});
