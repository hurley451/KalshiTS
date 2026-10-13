import test from "node:test";
import * as sdk from "../dist/src/index.js";
import { proveCfWire, proveCfNegatives, proveCfErrors, proveCfOptions } from "./helpers/cf-wire.mjs";

test("CF helpers/raw/registry actual GET sockets and RSA-PSS/Ed25519 signatures", () => proveCfWire(sdk));
test("CF path/query/auth/sparse/inherited negatives dispatch zero HTTP", () => proveCfNegatives(sdk));
test("CF opaque envelopes, every failure format/status, bytes, redirects and interrupted reads", () => proveCfErrors(sdk));
test("CF configured cost50/caller override, options snapshots, cancellation and safe retries", () => proveCfOptions(sdk));
