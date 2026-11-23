/** The numbers of forebay-library's enums this plugin compares answers with; each enum is append-only. */

export const ROUTE = { MESSAGES: 1, MODEL_LIST: 2, MODEL_LOOKUP: 3, PASS_THROUGH: 4 } as const;

export const ARRIVAL = { ROUTE: 1, HEALTH: 2, REFUSE: 3 } as const;

export const STEP = { PASS_THROUGH: 1, REFRESH_MODELS: 2, CALL_PROVIDER: 3, REPLY: 4, END_STREAM: 5, DONE: 6 } as const;

export const REPORT = { RESPONSE: 1, STREAMED: 2, STREAM_FAILED: 3, THROWN: 4, FAILURE: 5 } as const;

export const REPLY = { PROXY_ERROR: 1, API_ERROR: 2, PROVIDER_FAILURE: 3, RATE_LIMITED: 4, INVALID_REQUEST: 5 } as const;

export const PROVIDER_HANDLE = { RESPONSE: 1, FAILURE: 2, STREAM: 3, THROWN: 4 } as const;

export const PROVIDER_NEXT = { EVENT: 1, END: 2, FAILURE: 3 } as const;

export const FAILURE_REASON = { UPSTREAM_UNREACHABLE: 1, REQUEST_FAILED: 2 } as const;

export const IR_EVENT_ERROR = 10;

export const LOG_LEVEL = { INFO: 1, WARN: 2 } as const;

export const CATALOG_EVENT = { READ: 1, NO_MODEL: 2, ANSWERED: 3, TIMER: 4 } as const;

export const CATALOG_TIMER = { ROUND_CLOSE: 1, PERIOD: 2 } as const;

export const CATALOG_TIMER_CHANGE = { SET: 1, CLEAR: 2 } as const;

export const STATUS = { OUT_OF_MEMORY: 4 } as const;

export const WEIVEL_LOG = { INFO: 3, WARN: 4 } as const;
