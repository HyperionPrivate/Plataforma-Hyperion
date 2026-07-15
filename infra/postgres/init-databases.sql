-- Databases dedicadas por microservicio (database-per-service).
-- Se ejecuta solo en el primer arranque del volumen Postgres.

CREATE DATABASE db_orchestrator;
CREATE DATABASE db_crm;
CREATE DATABASE db_compliance;
CREATE DATABASE db_whatsapp;
CREATE DATABASE db_identity;
CREATE DATABASE db_documents;
CREATE DATABASE db_handoff;
CREATE DATABASE db_segmentation;
CREATE DATABASE db_agent_config;
CREATE DATABASE db_analytics;
