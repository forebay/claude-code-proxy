import type { DecodeRequestAnswer, IrFailure, WireRequest } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";

const ROUTED_METHOD = "POST";
const ROUTED_PATH = "/v1/messages";

function isRouted(request: WireRequest): boolean {
  const path = request.path.split("?")[0];
  return request.method.toUpperCase() === ROUTED_METHOD && path === ROUTED_PATH;
}

function invalidRequest(message: string): IrFailure {
  const error = { type: "invalid_request_error", message };
  return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "error", error }) };
}

function parsedObject(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the request body must be a JSON object");
  return parsed;
}

/** Routes only `POST /v1/messages`; everything else goes to the upstream as it came. */
export function decodeRequest(request: WireRequest): DecodeRequestAnswer {
  if (!isRouted(request)) return { passThrough: true };
  try {
    return anthropicTranslator.decodeRequest(parsedObject(request.body));
  } catch (error) {
    return invalidRequest(`the request body is not a valid Messages API request: ${(error as Error).message}`);
  }
}
