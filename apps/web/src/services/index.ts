import * as mock from "./mock";
import * as live from "./live";

const mode = process.env.NEXT_PUBLIC_API_MODE ?? "mock";

export const api = mode === "live" ? live : mock;
export { createLiveEvent } from "./mock";
