#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const SAFE_COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export function resolveComposeImageReference(model, projectName, serviceName) {
  if (!SAFE_COMPOSE_NAME.test(projectName)) throw new Error("Compose project name is unsafe");
  if (!SAFE_COMPOSE_NAME.test(serviceName)) throw new Error("Compose service name is unsafe");
  if (!isRecord(model) || !isRecord(model.services)) throw new Error("Compose model has no services object");
  const service = model.services[serviceName];
  if (!isRecord(service)) throw new Error(`Compose service ${serviceName} does not exist`);
  if (!isRecord(service.build)) throw new Error(`Compose service ${serviceName} is not build-owned`);
  const explicitImage = typeof service.image === "string" ? service.image.trim() : "";
  return explicitImage || `${projectName}-${serviceName}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") options.projectName = argv[++index];
    else if (argument === "--service") options.serviceName = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.projectName || !options.serviceName) throw new Error("--project and --service are required");
  return options;
}

async function readStandardInput() {
  let contents = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) contents += chunk;
  if (!contents.trim()) throw new Error("Compose JSON is required on stdin");
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error("Compose JSON on stdin is invalid");
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const model = await readStandardInput();
  process.stdout.write(`${resolveComposeImageReference(model, options.projectName, options.serviceName)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
