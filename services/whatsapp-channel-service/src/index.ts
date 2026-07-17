import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "whatsapp-channel-service",
  databaseRequired: true,
  requiredMigrations: [
    "012-whatsapp-sofia-runtime.sql",
    "017-whatsapp-channel-durability.sql",
    "021-autonomous-event-flow.sql",
    "023-channel-inbound-outbox-backfill.sql",
    "030-channel-conversation-ordering.sql",
    "031-channel-conversation-ordering-indexes.sql",
    "034-channel-conversation-ordering-contract.sql"
  ],
  registerRoutes
});
