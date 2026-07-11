import type { FastifyReply, FastifyRequest } from "fastify";

export function createRequestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new DOMException("Client request aborted", "AbortError"));
  const abortResponse = () => {
    if (!reply.raw.writableEnded) abortRequest();
  };

  request.raw.once("aborted", abortRequest);
  reply.raw.once("close", abortResponse);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off("aborted", abortRequest);
      reply.raw.off("close", abortResponse);
    }
  };
}
