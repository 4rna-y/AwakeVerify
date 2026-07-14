import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type LoadTestConfig = {
    concurrentSessions: number;
    durationSeconds: number;
    framesPerSecond: number;
    frameFixture: string;
    apiBaseUrl: URL;
    allowAzureLoadTest: boolean;
    rampUpSeconds: number;
    resultTimeoutSeconds: number;
    maxInFlightFrames: number;
    outputPath: string;
    faultInjection: ReadonlySet<FaultInjection>;
};

export type FaultInjection = "signalr-reconnect" | "ws-reconnect" | "skip-sequence" | "duplicate-frame";

const faultInjectionValues: ReadonlySet<string> = new Set([
    "signalr-reconnect",
    "ws-reconnect",
    "skip-sequence",
    "duplicate-frame",
]);

const defaults = {
    concurrentSessions: 2,
    durationSeconds: 10,
    framesPerSecond: 1,
    frameFixture: "load-test/fixtures/transport-test.jpg",
    apiBaseUrl: "http://localhost:5194",
    allowAzureLoadTest: false,
    rampUpSeconds: 0,
    resultTimeoutSeconds: 15,
    maxInFlightFrames: 5,
    outputPath: "load-test-results/report.json",
} as const;

export function loadConfig(
    env: Readonly<Record<string, string | undefined>> = process.env,
    cwd = process.cwd(),
): LoadTestConfig {
    const apiBaseUrl = parseApiBaseUrl(env.API_BASE_URL ?? defaults.apiBaseUrl);
    const config: LoadTestConfig = {
        concurrentSessions: positiveInteger(env.CONCURRENT_SESSIONS, "CONCURRENT_SESSIONS", defaults.concurrentSessions),
        durationSeconds: positiveInteger(env.DURATION_SECONDS, "DURATION_SECONDS", defaults.durationSeconds),
        framesPerSecond: positiveNumber(env.FRAMES_PER_SECOND, "FRAMES_PER_SECOND", defaults.framesPerSecond),
        frameFixture: resolve(cwd, env.FRAME_FIXTURE ?? defaults.frameFixture),
        apiBaseUrl,
        allowAzureLoadTest: parseBoolean(env.ALLOW_AZURE_LOAD_TEST, "ALLOW_AZURE_LOAD_TEST", defaults.allowAzureLoadTest),
        rampUpSeconds: nonNegativeInteger(env.RAMP_UP_SECONDS, "RAMP_UP_SECONDS", defaults.rampUpSeconds),
        resultTimeoutSeconds: positiveInteger(env.RESULT_TIMEOUT_SECONDS, "RESULT_TIMEOUT_SECONDS", defaults.resultTimeoutSeconds),
        maxInFlightFrames: positiveInteger(env.MAX_IN_FLIGHT_FRAMES, "MAX_IN_FLIGHT_FRAMES", defaults.maxInFlightFrames),
        outputPath: resolve(cwd, env.OUTPUT_PATH ?? defaults.outputPath),
        faultInjection: parseFaultInjection(env.FAULT_INJECTION),
    };

    if (!existsSync(config.frameFixture)) {
        throw new Error("FRAME_FIXTURE must reference an existing JPEG fixture.");
    }
    if (isAzureHttpsEndpoint(config.apiBaseUrl) && !config.allowAzureLoadTest) {
        throw new Error("ALLOW_AZURE_LOAD_TEST=true is required when API_BASE_URL is an Azure HTTPS endpoint.");
    }
    return config;
}

export function isAzureHttpsEndpoint(url: URL): boolean {
    return url.protocol === "https:" && /(^|\.)azurewebsites\.net$|(^|\.)azurecontainerapps\.io$/i.test(url.hostname);
}

export function isHighLoad(config: Pick<LoadTestConfig, "concurrentSessions" | "durationSeconds" | "framesPerSecond">): boolean {
    return config.concurrentSessions > 5 || config.durationSeconds > 60 || config.framesPerSecond > 5;
}

function parseApiBaseUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("API_BASE_URL must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("API_BASE_URL must use http or https.");
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("API_BASE_URL must not contain credentials, a query string, or a fragment.");
    }
    url.pathname = url.pathname.replace(/\/$/, "");
    return url;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return Number(value);
}

function nonNegativeInteger(value: string | undefined, name: string, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return Number(value);
}

function positiveNumber(value: string | undefined, name: string, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a finite positive number.`);
    }
    return parsed;
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
    if (value === undefined || value === "") return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`${name} must be true or false.`);
}

function parseFaultInjection(value: string | undefined): ReadonlySet<FaultInjection> {
    if (value === undefined || value.trim() === "") return new Set();
    const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
    for (const injection of requested) {
        if (!faultInjectionValues.has(injection)) {
            throw new Error(`FAULT_INJECTION contains an unsupported value: ${injection}.`);
        }
    }
    return new Set(requested as FaultInjection[]);
}
