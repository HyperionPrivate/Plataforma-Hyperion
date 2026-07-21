---
documentType: runbook
status: draft
owner: nova-operations
issue: HYP-NOVA-017
reviewDue: 2026-08-21
---

# NOVA SIP DDI cutover

The Neutral Dialer source remains an external deployment dependency under ADR-0004. Apply
`infra/patches/neutral-dialer-static-demo-ddi.patch` to that checkout before building its image.
Static mode must select only the primary DDI; a multi-DDI pool is not evidence that the DDIs share
the same provider contract.

Before changing ElevenLabs, back up every configured phone-number object. Then run the idempotent
importer with the deployment env file and `--existing-only`; it updates only listable DDIs, writes the
agent plus outbound trunk configuration, and fails unless readback confirms address, transport,
media encryption and both G.711 codecs.

```text
ELEVENLABS_IMPORT_ENV_FILE=.env.contabo-next \
ELEVENLABS_PHONE_CONFIG_BACKUP=/absolute/restricted/backup.json \
node scripts/ops/backup-elevenlabs-phone-config.mjs

ELEVENLABS_IMPORT_ENV_FILE=.env.contabo-next \
node scripts/autonomy/elevenlabs-import-sip-ddi.mjs --split-ab --existing-only
```

The current VoipCentral parity contract is TCP, media encryption disabled, and codecs
`PCMA/8000,PCMU/8000`. TLS/SRTP may replace it only after the carrier confirms support and a
controlled call proves interoperability. A provider call whose result is `dispatch_unknown` is not
dispatched: Voice persists the Dialer/provider references and marks it `needs_reconciliation`.

Do not place or retry a real call as part of provisioning. A new controlled call requires a fresh
one-call authorization and a terminal reconciliation of any prior attempt.
