import type { Plugin } from "vite";

export interface ConsoleBundleProvenancePluginOptions {
  appRoot: string;
  entryModule: `workspace:${string}`;
  metafileName: string;
  product: string;
  workspaceRoot?: string;
}

export interface ConsoleBundleForbiddenMarker {
  label: string;
  pattern: RegExp;
}

export interface ConsoleBundlePolicy {
  allowedHyperionDependencies: readonly string[];
  allowedWorkspaceFiles: readonly string[];
  allowedWorkspaceRoots: readonly string[];
  displayName: string;
  entryModule: `workspace:${string}`;
  forbiddenMarkers: readonly ConsoleBundleForbiddenMarker[];
  metafileName: string;
  product: string;
  validateContents?: (contents: string) => void;
}

export interface ConsoleBundleVerificationOptions {
  appRoot: string;
  distRoot?: string;
}

export interface ConsoleBundleVerificationResult {
  chunks: number;
  modules: number;
  outputs: number;
}

export function createViteBundleProvenancePlugin(options: ConsoleBundleProvenancePluginOptions): Plugin;
export function verifyConsoleBundle(
  policy: ConsoleBundlePolicy,
  options: ConsoleBundleVerificationOptions
): ConsoleBundleVerificationResult;
