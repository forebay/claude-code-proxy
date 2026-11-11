import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";

const CONTRACTS = join(import.meta.dirname, "..", "siblings", "forebay-library", "contracts");
const FRONT_DOOR_ID = "https://forebay.github.io/library/contracts/front-door.schema.json";
const SCHEMA_FILES = ["ir.schema.json", "front-door.schema.json"];

function loadedAjv(): Ajv {
  const ajv = new Ajv({ strict: false, allErrors: true });
  for (const file of SCHEMA_FILES) ajv.addSchema(JSON.parse(readFileSync(join(CONTRACTS, file), "utf8")));
  return ajv;
}

const ajv = loadedAjv();

/** The problems the front-door contract finds in `value` as `definition`, empty when it conforms. */
export function contractProblems(definition: string, value: unknown): string[] {
  const validate = ajv.getSchema(`${FRONT_DOOR_ID}#/definitions/${definition}`);
  if (validate === undefined) throw new Error(`the front-door contract defines no ${definition}`);
  validate(value);
  return (validate.errors ?? []).map((problem) => `${problem.instancePath} ${problem.message}`);
}
