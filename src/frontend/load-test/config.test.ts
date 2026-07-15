import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { isAzureHttpsEndpoint, isHighLoad, loadConfig } from "./config";

const frontendRoot = resolve(import.meta.dirname, "..");

test("uses safe local defaults and resolves the fixture", () => {
    const config = loadConfig({ FRAME_FIXTURE: "load-test/config.test.ts" }, frontendRoot);

    assert.equal(config.concurrentSessions, 2);
    assert.equal(config.durationSeconds, 10);
    assert.equal(config.framesPerSecond, 1);
    assert.equal(config.apiBaseUrl.toString(), "http://localhost:5194/");
    assert.equal(config.faultInjection.size, 0);
});

test("requires an explicit local JPEG fixture", () => {
    assert.throws(() => loadConfig({}, frontendRoot), /FRAME_FIXTURE is required/);
});

test("rejects invalid numeric settings", () => {
    for (const [name, value] of [["CONCURRENT_SESSIONS", "0"], ["DURATION_SECONDS", "-1"], ["FRAMES_PER_SECOND", "NaN"]]) {
        assert.throws(() => loadConfig({ [name]: value }, frontendRoot), new RegExp(name));
    }
});

test("requires an explicit Azure opt-in", () => {
    assert.throws(
        () => loadConfig({
            API_BASE_URL: "https://load-test.azurewebsites.net",
            FRAME_FIXTURE: "load-test/config.test.ts",
        }, frontendRoot),
        /ALLOW_AZURE_LOAD_TEST=true/,
    );

    const config = loadConfig({
        API_BASE_URL: "https://load-test.azurewebsites.net",
        ALLOW_AZURE_LOAD_TEST: "true",
        FAULT_INJECTION: "signalr-reconnect,duplicate-frame",
        FRAME_FIXTURE: "load-test/config.test.ts",
    }, frontendRoot);
    assert.equal(isAzureHttpsEndpoint(config.apiBaseUrl), true);
    assert.deepEqual([...config.faultInjection], ["signalr-reconnect", "duplicate-frame"]);
    assert.equal(isHighLoad(config), false);
});
