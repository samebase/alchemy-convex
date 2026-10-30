// The authenticated, redacted reads of the store app, from src/store/functions.ts.
import { readerFunctions } from "../functions.js";
import { components } from "./_generated/api.js";

export const { authorize, repository } = readerFunctions(components.alchemyState);
