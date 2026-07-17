import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "agent-service",
  databaseRequired: true,
  requiredMigrations: [
    "001-platform.sql",
    "012-whatsapp-sofia-runtime.sql",
    "013-sofia-confirmation-protocol.sql",
    "014-sofia-local-time-protocol.sql",
    "015-sofia-fresh-availability.sql",
    "016-sofia-search-constraints.sql",
    "021-autonomous-event-flow.sql",
    "026-audit-source-provenance.sql",
    "035-pulso-sofia-conversation-ordering.sql",
    "036-pulso-sofia-conversation-ordering-backfill.sql",
    "037-pulso-sofia-conversation-ordering-indexes.sql"
  ],
  registerRoutes
});
