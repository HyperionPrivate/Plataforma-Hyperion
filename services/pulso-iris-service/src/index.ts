import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "pulso-iris-service",
  databaseRequired: true,
  requiredMigrations: [
    "006-tenant-isolation.sql",
    "008-agenda-configuration.sql",
    "009-agenda-slot-engine.sql",
    "010-agenda-rules.sql",
    "011-configurable-agenda.sql",
    "012-whatsapp-sofia-runtime.sql",
    "021-autonomous-event-flow.sql",
    "030-channel-conversation-ordering.sql",
    "031-channel-conversation-ordering-indexes.sql",
    "034-channel-conversation-ordering-contract.sql",
    "035-pulso-sofia-conversation-ordering.sql",
    "036-pulso-sofia-conversation-ordering-backfill.sql",
    "037-pulso-sofia-conversation-ordering-indexes.sql"
  ],
  registerRoutes
});
