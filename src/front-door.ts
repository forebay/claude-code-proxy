import type { FrontDoor } from "@forebay/host";
import { decodeRequest } from "./decode-request.js";
import { encodeEvent, encodeResponse } from "./encode.js";
import { profile } from "./profile.js";
import { rateLimitReply } from "./rate-limit-reply.js";

export function frontDoor(upstream: string): FrontDoor {
  return { profile: () => profile(upstream), decodeRequest, encodeResponse, encodeEvent, rateLimitReply };
}
