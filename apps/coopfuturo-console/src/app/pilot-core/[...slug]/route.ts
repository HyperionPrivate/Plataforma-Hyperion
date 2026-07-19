import type { NextRequest } from "next/server";
import { handleCoopfuturoNovaRequest } from "@/server/coopfuturo-nova-adapter";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string[] }> };

async function handle(request: NextRequest, context: RouteContext) {
  const { slug } = await context.params;
  return handleCoopfuturoNovaRequest(request, slug ?? []);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
