import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { isAzureHttpsEndpoint, isHighLoad, loadConfig } from "./config";

const frontendRoot = resolve(import.meta.dirname, "..");

test("uses safe local defaults and resolves the fixture", () => {
    const config = loadConfig({}, frontendRoot);

    assert.equal(config.concurrentSessions, 2);
    assert.equal(config.durationSeconds, 10);
    assert.equal(config.framesPerSecond, 1);
    assert.equal(config.apiBaseUrl.toString(), "http://localhost:5194/");
    assert.equal(config.faultInjection.size, 0);
});

test("rejects invalid numeric settings", () => {
    for (const [name, value] of [["CONCURRENT_SESSIONS", "0"], ["DURATION_SECONDS", "-1"], ["FRAMES_PER_SECOND", "NaN"]]) {
        assert.throws(() => loadConfig({ [name]: value }, frontendRoot), new RegExp(name));
    }
});

test("requires an explicit Azure opt-in", () => {
    assert.throws(
        () => loadConfig({ API_BASE_URL: "https://load-test.azurewebsites.net" }, frontendRoot),
        /ALLOW_AZURE_LOAD_TEST=true/,
    );

    const config = loadConfig({
        API_BASE_URL: "https://load-test.azurewebsites.net",
        ALLOW_AZURE_LOAD_TEST: "true",
        FAULT_INJECTION: "signalr-reconnect,duplicate-frame",
    }, frontendRoot);
    assert.equal(isAzureHttpsEndpoint(config.apiBaseUrl), true);
    assert.deepEqual([...config.faultInjection], ["signalr-reconnect", "duplicate-frame"]);
    assert.equal(isHighLoad(config), false);
});

test("fixture is a complete independent JPEG", async () => {
    const fixture = await readFile(resolve(frontendRoot, "load-test/fixtures/transport-test.jpg"));

    assert.equal(fixture[0], 0xff);
    assert.equal(fixture[1], 0xd8);
    assert.equal(fixture.at(-2), 0xff);
    assert.equal(fixture.at(-1), 0xd9);
});
