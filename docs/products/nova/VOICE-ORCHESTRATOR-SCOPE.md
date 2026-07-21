# NOVA Calls + Orchestrator — frozen scope

Status: engineering baseline. Business and legal approval by Coopfuturo is still pending.

## In scope

- NOVA Core owns campaign state, contact eligibility, frequency limits and the authorization to place every call.
- Voice owns provider transport, provider correlation, webhook/poller reconciliation and call-result publication.
- A call may reach Voice only as a durable `voice.call.requested.v2` event emitted by Core after an atomic compliance decision. Voice retains the published `voice.call.requested` v1 consumer during the N−1 window.
- Manual calls and campaign calls use the same Core authorization path.
- Campaign pause/cancel prevents new authorizations; already dispatched provider calls require Voice reconciliation.
- Operator actions use the operator identity verified by the gateway assertion, never an identity supplied only in the body.
- Contacts, leads, manual calls, campaign enrollment, handoffs and conversations are restricted to the agencies granted to the verified operator.

## WhatsApp boundary (out of implementation scope)

The WhatsApp transport and conversational flow are owned by another team. NOVA Calls may only consume or emit the existing durable contracts needed for coordination:

- `wa.message.received` / `contact.opt_out`: suppress future calls before dispatch.
- `wa.send.requested`: optional post-call handoff request; delivery is not a Calls responsibility.
- `handoff.requested`: provider-neutral transfer into the operator queue.

No Calls acceptance criterion may depend on changing the WhatsApp transport implementation. Contract compatibility and idempotency at this boundary remain required.

## Initial tenant policy represented in the Coopfuturo document

- Contact window: Monday–Saturday, 08:00–19:00, `America/Bogota`.
- Holidays excluded.
- At most 2 attempts per local day.
- At least 4 hours between attempts.
- At most 4 attempts in a rolling 7-day window.
- Opt-out is immediate.

These values become safe defaults and tenant-configurable settings. They are not described as legally approved until Coopfuturo supplies that approval and the production tenant stores the approved values.

## Explicitly excluded from voice capture

The call performs only initial qualification and consented routing. Long-form or sensitive renewal data, documents and WhatsApp conversation details are not collected by the Voice implementation in this scope.

## Cutover invariant

Production call dispatch is allowed only when all of the following are true in one database transaction immediately before queuing:

1. Tenant and campaign (when present) are active.
2. Contact exists, has not opted out and is not in an exclusion registry.
3. Tenant channel, weekday, local contact window and holiday policy allow contact.
4. Daily, rolling-window and minimum-separation frequency limits allow contact.
5. The attempt reservation, enrollment update and durable `voice.call.requested.v2` event commit together.

Any missing policy data, invalid timezone, unavailable live Core verification where required, or ambiguous provider result fails closed and is visible for reconciliation.
