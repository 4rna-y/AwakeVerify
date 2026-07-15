import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import * as signalR from "@microsoft/signalr";
import { type FaultInjection, isAzureHttpsEndpoint, isHighLoad, loadConfig, type LoadTestConfig } from "./config";
import { meetsFrameToResultSlo, Metrics, type Summary } from "./metrics";

type AnalysisEvent = { sessionId?: unknown; sourceSequenceNo?: unknown };
type RunAssertions = {
    sessionIsolation: boolean;
    sameSessionAcceptanceOrder: boolean;
    parallelSessionsActivated: boolean;
    noTimeouts: boolean;
    frameToResultLatencySlo: boolean;
};
type Report = {
    schemaVersion: 2;
    completedAt: string;
    configuration: {
        targetKind: "local" | "azure";
        concurrentSessions: number;
        durationSeconds: number;
        framesPerSecond: number;
        rampUpSeconds: number;
        resultTimeoutSeconds: number;
        faultInjection: FaultInjection[];
    };
    summary: Summary;
    assertions: RunAssertions;
};

class CookieJar {
    private readonly cookies = new Map<string, string>();

    public addSetCookies(response: Response): void {
        const headers = response.headers as Headers & { getSetCookie?: () => string[] };
        const setCookies = headers.getSetCookie?.() ?? splitSetCookie(response.headers.get("set-cookie"));
        for (const setCookie of setCookies) {
            const [pair] = setCookie.split(";", 1);
            const separator = pair?.indexOf("=") ?? -1;
            if (separator <= 0) continue;
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            if (name) this.cookies.set(name, value);
        }
    }

    public header(): string {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    }
}

class VirtualSession {
    private readonly cookieJar = new CookieJar();
    private readonly sentAtBySequence = new Map<number, number>();
    private sessionId = "";
    private csrfToken = "";
    private connection: signalR.HubConnection | undefined;
    private nextSequenceNo = 1;
    private inFlight = false;
    private highestAcceptedSequence = 0;
    private acceptanceOrderValid = true;

    public constructor(
        private readonly config: LoadTestConfig,
        private readonly fixture: Buffer,
        private readonly metrics: Metrics,
    ) {}

    public get acceptanceOrderIsValid(): boolean {
        return this.acceptanceOrderValid;
    }

    public async run(startDelayMs: number): Promise<void> {
        try {
            await delay(startDelayMs);
            await this.startSession();
            await this.connectResultStream();

            const startedAt = Date.now();
            const endsAt = startedAt + this.config.durationSeconds * 1000;
            let injected = false;
            while (Date.now() < endsAt) {
                if (!injected && Date.now() - startedAt >= (endsAt - startedAt) / 2) {
                    injected = true;
                    await this.injectConfiguredFaults();
                }
                this.metrics.increment("framesOffered");
                void this.sendNextFrame();
                await delay(Math.max(1, Math.round(1000 / this.config.framesPerSecond)));
            }

            await delay(this.config.resultTimeoutSeconds * 1000);
            for (const sequenceNo of this.sentAtBySequence.keys()) {
                this.metrics.increment("timeouts");
                this.sentAtBySequence.delete(sequenceNo);
            }
        } finally {
            await this.close();
        }
    }

    private async startSession(): Promise<void> {
        const response = await fetch(endpoint(this.config.apiBaseUrl, "/api/sessions"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                studentId: `load-test-${randomUUID()}`,
                videoId: "load-test-fixture",
            }),
        });
        if (!response.ok) throw new Error("Session creation was rejected.");
        this.cookieJar.addSetCookies(response);
        this.csrfToken = response.headers.get("X-CSRF-Token") ?? "";
        const payload = await response.json() as { sessionId?: unknown };
        if (typeof payload.sessionId !== "string" || this.cookieJar.header() === "" || this.csrfToken === "") {
            throw new Error("Session creation did not return an isolated authenticated session.");
        }
        this.sessionId = payload.sessionId;
        this.metrics.increment("sessionsCreated");
    }

    private async connectResultStream(): Promise<void> {
        const connection = new signalR.HubConnectionBuilder()
            .withUrl(endpoint(this.config.apiBaseUrl, "/hubs/analysis-events"), {
                headers: { Cookie: this.cookieJar.header() },
                transport: signalR.HttpTransportType.WebSockets,
            })
            .configureLogging(signalR.LogLevel.None)
            .withAutomaticReconnect([0, 500, 1_000, 2_000])
            .build();
        this.connection = connection;
        connection.on("ReceiveAnalysisEvent", (event: unknown) => this.recordAnalysisEvent(event));
        connection.onreconnecting(() => this.metrics.increment("signalRReconnects"));
        connection.onreconnected(async () => {
            this.metrics.increment("signalRReconnects");
            await connection.invoke("JoinSession", this.sessionId);
        });
        await connection.start();
        await connection.invoke("JoinSession", this.sessionId);
    }

    private async sendNextFrame(): Promise<void> {
        const capturedSequenceNo = this.nextSequenceNo;
        this.nextSequenceNo += 1;
        if (this.inFlight) {
            this.metrics.increment("framesNotSentDueToInFlightLimit");
            return;
        }

        let sequenceNo = capturedSequenceNo;
        if (this.config.faultInjection.has("skip-sequence") && sequenceNo === 3) {
            sequenceNo = this.nextSequenceNo;
            this.nextSequenceNo += 1;
        }
        const capturedAt = new Date().toISOString();
        const videoTimeSec = Math.max(0, (Date.now() / 1000) % 3600);
        this.inFlight = true;
        this.sentAtBySequence.set(sequenceNo, Date.now());
        try {
            const accepted = await this.postFrame(sequenceNo, capturedAt, videoTimeSec);
            if (accepted && this.config.faultInjection.has("duplicate-frame") && sequenceNo === 3) {
                await this.postFrame(sequenceNo, capturedAt, videoTimeSec);
            }
        } finally {
            this.inFlight = false;
        }
    }

    private async postFrame(sequenceNo: number, capturedAt: string, videoTimeSec: number): Promise<boolean> {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            let response: Response;
            try {
                response = await fetch(endpoint(this.config.apiBaseUrl, `/api/sessions/${this.sessionId}/frames/${sequenceNo}`), {
                    method: "POST",
                    headers: {
                        Cookie: this.cookieJar.header(),
                        "Content-Type": "image/jpeg",
                        "X-CSRF-Token": this.csrfToken,
                        "X-Frame-Captured-At": capturedAt,
                        "X-Frame-Video-Time-Sec": String(videoTimeSec),
                    },
                    body: this.fixture.buffer.slice(
                        this.fixture.byteOffset,
                        this.fixture.byteOffset + this.fixture.byteLength,
                    ) as ArrayBuffer,
                });
            } catch {
                this.metrics.increment("retryableRejections");
                if (attempt < 3) {
                    this.metrics.increment("retransmissions");
                    await delay(250 * 2 ** (attempt - 1));
                    continue;
                }
                return false;
            }
            this.cookieJar.addSetCookies(response);
            this.csrfToken = response.headers.get("X-CSRF-Token") ?? this.csrfToken;
            this.metrics.increment("framesSent");

            if (response.status === 202) {
                if (sequenceNo < this.highestAcceptedSequence) this.acceptanceOrderValid = false;
                this.highestAcceptedSequence = Math.max(this.highestAcceptedSequence, sequenceNo);
                this.metrics.increment("acceptedFrames");
                return true;
            }
            if (response.status !== 429 && response.status !== 503) {
                this.metrics.increment("permanentRejections");
                return false;
            }

            this.metrics.increment("retryableRejections");
            if (attempt < 3) {
                this.metrics.increment("retransmissions");
                await delay(retryDelayMs(response, attempt));
            }
        }
        return false;
    }

    private recordAnalysisEvent(event: unknown): void {
        if (!isAnalysisEvent(event)) return;
        if (event.sessionId !== this.sessionId) {
            this.metrics.increment("crossSessionDeliveries");
            return;
        }
        this.metrics.increment("analysisResultsReceived");
        if (typeof event.sourceSequenceNo !== "number") return;
        const sentAt = this.sentAtBySequence.get(event.sourceSequenceNo);
        if (sentAt === undefined) return;
        this.metrics.recordLatency(Date.now() - sentAt);
        this.sentAtBySequence.delete(event.sourceSequenceNo);
    }

    private async injectConfiguredFaults(): Promise<void> {
        if (this.config.faultInjection.has("signalr-reconnect") && this.connection) {
            await this.connection.stop();
            this.metrics.increment("signalRReconnects");
            await this.connection.start();
            await this.connection.invoke("JoinSession", this.sessionId);
        }
    }

    private async close(): Promise<void> {
        if (this.connection) await this.connection.stop();
    }
}

async function main(): Promise<void> {
    const config = loadConfig();
    const fixture = await readJpegFixture(config.frameFixture);
    await confirmAzureLoadTest(config, fixture.byteLength);

    const metrics = new Metrics();
    const startedAt = Date.now();
    const sessions = Array.from({ length: config.concurrentSessions }, () => new VirtualSession(config, fixture, metrics));
    const rampIntervalMs = config.concurrentSessions > 1 ? (config.rampUpSeconds * 1000) / (config.concurrentSessions - 1) : 0;
    const results = await Promise.allSettled(sessions.map((session, index) => session.run(Math.round(index * rampIntervalMs))));
    const summary = metrics.summarize(Date.now() - startedAt);
    const assertions: RunAssertions = {
        sessionIsolation: summary.crossSessionDeliveries === 0,
        sameSessionAcceptanceOrder: sessions.every((session) => session.acceptanceOrderIsValid),
        parallelSessionsActivated: config.concurrentSessions < 2 || summary.sessionsCreated >= 2,
        noTimeouts: summary.timeouts === 0,
        frameToResultLatencySlo: meetsFrameToResultSlo(summary.frameToResultLatencyMs),
    };
    const report: Report = {
        schemaVersion: 2,
        completedAt: new Date().toISOString(),
        configuration: {
            targetKind: isAzureHttpsEndpoint(config.apiBaseUrl) ? "azure" : "local",
            concurrentSessions: config.concurrentSessions,
            durationSeconds: config.durationSeconds,
            framesPerSecond: config.framesPerSecond,
            rampUpSeconds: config.rampUpSeconds,
            resultTimeoutSeconds: config.resultTimeoutSeconds,
            faultInjection: [...config.faultInjection],
        },
        summary,
        assertions,
    };
    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    // No target URL, principal, cookie, token, student ID, session ID, or frame content is emitted.
    output.write(`${JSON.stringify(report.summary)}\n`);
    if (results.some((result) => result.status === "rejected") || Object.values(assertions).some((assertion) => !assertion)) {
        process.exitCode = 1;
    }
}

async function confirmAzureLoadTest(config: LoadTestConfig, fixtureBytes: number): Promise<void> {
    if (!isAzureHttpsEndpoint(config.apiBaseUrl)) return;
    const estimatedFrames = Math.ceil(config.concurrentSessions * config.durationSeconds * config.framesPerSecond);
    const estimatedUploadMiB = (estimatedFrames * fixtureBytes) / (1024 * 1024);
    output.write(`Azure load-test preflight\nTarget URL: ${config.apiBaseUrl.toString()}\nConcurrent sessions: ${config.concurrentSessions}\nDuration: ${config.durationSeconds}s\nEstimated frames: ${estimatedFrames}\nEstimated frame upload: ${estimatedUploadMiB.toFixed(2)} MiB\nCost impact: Blob, Service Bus, SignalR, Backend, and ACA Worker consumption will increase; verify the test resource group and cost cap.\n`);
    if (!isHighLoad(config)) return;
    if (!input.isTTY) throw new Error("Azure high-load execution requires an interactive confirmation.");
    const readline = createInterface({ input, output });
    const answer = await readline.question("Type START to begin the Azure high-load test: ");
    readline.close();
    if (answer !== "START") throw new Error("Azure high-load execution was not confirmed.");
}

async function readJpegFixture(path: string): Promise<Buffer> {
    const fixture = await readFile(path);
    if (fixture.byteLength < 4 || fixture[0] !== 0xff || fixture[1] !== 0xd8 || fixture.at(-2) !== 0xff || fixture.at(-1) !== 0xd9) {
        throw new Error("FRAME_FIXTURE must be a complete JPEG file.");
    }
    return fixture;
}

function endpoint(baseUrl: URL, pathname: string): string {
    const url = new URL(baseUrl.toString());
    url.pathname = pathname;
    url.search = "";
    return url.toString();
}

function retryDelayMs(response: Response, attempt: number): number {
    const retryAfterSec = Number(response.headers.get("Retry-After"));
    return Number.isFinite(retryAfterSec) && retryAfterSec >= 0
        ? retryAfterSec * 1000
        : 500 * 2 ** (attempt - 1);
}

function isAnalysisEvent(value: unknown): value is AnalysisEvent {
    return typeof value === "object" && value !== null && "sessionId" in value;
}

function splitSetCookie(value: string | null): string[] {
    if (!value) return [];
    return value.split(/,(?=\s*[^;=]+=[^;]+)/u);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

void main().catch(() => {
    // Deliberately avoid serializing errors because they may contain sensitive request details.
    output.write("Load test failed before completion. Check configuration and service health.\n");
    process.exitCode = 1;
});
