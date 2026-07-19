import { RELEASE_CELLS } from "./release-model.mjs";
import { PROVIDER_CONTRACTS } from "./provider-contract-compatibility.mjs";

export function assertReleaseCell(cell) {
  if (!RELEASE_CELLS.includes(cell)) {
    throw new Error(`Unknown release cell ${JSON.stringify(cell)}; expected one of ${RELEASE_CELLS.join(", ")}`);
  }
  return cell;
}

export function selectedReleaseCells(cell = null) {
  return cell === null ? [...RELEASE_CELLS] : [assertReleaseCell(cell)];
}

export function providerContractIdsForCell(cell = null) {
  if (cell !== null) assertReleaseCell(cell);
  return Object.entries(PROVIDER_CONTRACTS)
    .filter(([, provider]) => cell === null || provider.cell === cell)
    .map(([id]) => id);
}

export function parseCellScopeArguments(argv) {
  let cell = null;
  let cellSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--" || argument === "") continue;
    if (argument !== "--cell") throw new Error(`Unknown argument: ${argument}`);
    if (cellSeen) throw new Error("--cell may be supplied only once");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--cell requires a value");
    cell = assertReleaseCell(value);
    cellSeen = true;
    index += 1;
  }
  return { cell };
}
