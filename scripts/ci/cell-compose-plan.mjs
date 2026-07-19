import process from "node:process";
import {
  CELL_COMPOSE_DESCRIPTORS,
  CELL_COMPOSE_SERVICES,
  CELL_SMOKE_TARGETS,
  assertCell
} from "../architecture/cell-policy.mjs";

const [cell, output = "services"] = process.argv.slice(2);
assertCell(cell);

if (output === "services") {
  process.stdout.write(`${CELL_COMPOSE_SERVICES[cell].join(" ")}\n`);
} else if (output === "smoke-service") {
  process.stdout.write(`${CELL_SMOKE_TARGETS[cell].service}\n`);
} else if (output === "smoke-artifact") {
  process.stdout.write(`${CELL_SMOKE_TARGETS[cell].artifact}\n`);
} else if (output === "compose-file") {
  process.stdout.write(`${CELL_COMPOSE_DESCRIPTORS[cell].composeFile}\n`);
} else if (output === "env-file") {
  process.stdout.write(`${CELL_COMPOSE_DESCRIPTORS[cell].envFile}\n`);
} else {
  throw new Error("Usage: cell-compose-plan.mjs <cell> [services|smoke-service|smoke-artifact|compose-file|env-file]");
}
