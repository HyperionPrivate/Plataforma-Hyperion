# Producer-consumer registry (planned commercial events)

Handlers are NOT implemented in architecture foundation. Schemas + examples only.

| event_type | producer | consumers | classification |
|---|---|---|---|
| contact.imported | pilot-core.contacts | segmentation, compliance | restricted_pii (minimize) |
| contact.scored | pilot-core.segmentation | campaigns, crm | internal |
| contact.eligibility.decided | pilot-core.compliance | orchestration, campaigns | internal |
| campaign.enrolled | pilot-core.campaigns | analytics_projection | internal |
| contact.attempt.requested | pilot-core.orchestration | analytics_projection | internal |
| call.requested | pilot-core.orchestration | (dialer via HTTP, not bus) | internal |
| call.completed | pilot-core.orchestration | crm, analytics_projection | internal |
| wa.send.requested | pilot-core | whatsapp-adapter | internal |
| wa.message.received | whatsapp-adapter | pilot-core.crm | confidential |
| document.received | documents | pilot-core.crm | internal (refs only) |
| document.validated | documents | pilot-core.crm | internal |
| lead.qualified | pilot-core.crm | handoff-liwa | internal |
| handoff.created | handoff-liwa | pilot-core, analytics_projection | internal |
| handoff.resolved | handoff-liwa | pilot-core.crm | internal |
| preference.changed | whatsapp-adapter / pilot-core | compliance | internal |
| contact.suppressed | pilot-core.compliance | orchestration, whatsapp-adapter | internal |
| core.outcome.recorded | pilot-core.core_adapter | crm, analytics_projection | internal |
| platform.synthetic.ping | any unit (_tech) | same unit inbox | internal |
