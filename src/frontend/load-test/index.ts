import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import * as signalR from "@microsoft/signalr";
import WebSocket from "ws";
import { type FaultInjection, isAzureHttpsEndpoint, isHighLoad, loadConfig, type LoadTestConfig } from "./config";
import { Metrics, type Summary } from "./metrics";

type FrameProtocolMessage = {
    type?: unknown;
    sequenceNo?: unknown;
    retryable?: unknown;
};

type AnalysisEvent = {
    sessionId?: unknown;
    sourceSequenceNo?: unknown;
};

type RunAssertions = {
    sessionIsolation: boolean;
    sameSessionAcknowledgementOrder: boolean;
    parallelSessionsActivated: boolean;
};

type Report = {
    schemaVersion: 1;
    completedAt: string;
    configuration: {
        targetKind: "local" | "azure";
        concurrentSessions: number;
        durationSeconds: number;
        framesPerSecond: number;
        rampUpSeconds: number;
        resultTimeoutSeconds: number;
        maxInFlightFrames: number;
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
    private readonly pendingFrames = new Map<number, { payload: string; retransmissions: number }>();
    private sessionId = "";
    private connection: signalR.HubConnection | undefined;
    private socket: WebSocket | undefined;
    private nextSequenceNo = 1;
    private highestAcknowledgedSequence = 0;
    private acknowledgementOrderValid = true;
    private maintainFrameSocket = true;
    private reconnectPromise: Promise<void> | undefined;

    public constructor(
        private readonly config: LoadTestConfig,
        private readonly fixtureBase64: string,
        private readonly metrics: Metrics,
    ) {}

    public get acknowledgementOrderIsValid(): boolean {
        return this.acknowledgementOrderValid;
    }

    public async run(startDelayMs: number): Promise<void> {
        try {
            await delay(startDelayMs);
            await this.startSession();
            await this.connectResultStream();
            await this.connectFrameSocket(false);

            const startedAt = Date.now();
            const endsAt = startedAt + this.config.durationSeconds * 1000;
            let injected = false;
            while (Date.now() < endsAt) {
                if (!injected && Date.now() - startedAt >= (endsAt - startedAt) / 2) {
                    injected = true;
                    await this.injectConfiguredFaults();
                }
                await this.sendNextFrame();
                await delay(Math.max(1, Math.round(1000 / this.config.framesPerSecond)));
            }

            await delay(this.config.resultTimeoutSeconds * 1000);
            for (const sequenceNo of this.pendingFrames.keys()) {
                this.metrics.increment("timeouts");
                this.sentAtBySequence.delete(sequenceNo);
            }
            this.pendingFrames.clear();
        } finally {
            await this.close();
        }
    }

    private async startSession(): Promise<void> {
        const response = await fetch(endpoint(this.config.apiBaseUrl, "/api/sessions"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                // Generated identities prevent one virtual user from sharing another user's principal.
                studentId: `load-test-${randomUUID()}`,
                videoId: "load-test-fixture",
            }),
        });
        if (!response.ok) throw new Error("Session creation was rejected.");
        this.cookieJar.addSetCookies(response);
        const payload = await response.json() as { sessionId?: unknown };
        if (typeof payload.sessionId !== "string" || this.cookieJar.header() === "") {
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

    private async connectFrameSocket(isReconnect: boolean): Promise<void> {
        const socket = new WebSocket(toWebSocketUrl(endpoint(this.config.apiBaseUrl, `/ws/sessions/${this.sessionId}/frames`)), {
            headers: { Cookie: this.cookieJar.header() },
        });
        this.socket = socket;
        socket.on("message", (data) => this.handleFrameProtocolMessage(data.toString("utf8")));
        socket.on("error", () => undefined);
        try {
            await onceOpen(socket);
            socket.on("close", () => this.handleUnexpectedFrameSocketClose(socket));
            if (isReconnect) this.metrics.increment("webSocketReconnects");
        } catch {
            this.metrics.increment("webSocketConnectionFailures");
            throw new Error("Frame WebSocket connection failed.");
        }
    }

    private async sendNextFrame(): Promise<void> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
        if (this.pendingFrames.size >= this.config.maxInFlightFrames) return;

        let sequenceNo = this.nextSequenceNo;
        this.nextSequenceNo += 1;
        if (this.config.faultInjection.has("skip-sequence") && sequenceNo === 3) {
            sequenceNo = this.nextSequenceNo;
            this.nextSequenceNo += 1;
        }
        const payload = JSON.stringify({
            sessionId: this.sessionId,
            sequenceNo,
            capturedAt: new Date().toISOString(),
            videoTimeSec: Math.max(0, (Date.now() / 1000) % 3600),
            codec: "image/jpeg",
            payloadBase64: this.fixtureBase64,
        });
        this.pendingFrames.set(sequenceNo, { payload, retransmissions: 0 });
        this.sentAtBySequence.set(sequenceNo, Date.now());
        this.socket.send(payload);
        this.metrics.increment("framesSent");

        if (this.config.faultInjection.has("duplicate-frame") && sequenceNo === 3) {
            this.socket.send(payload);
            this.metrics.increment("framesSent");
        }
    }

    private handleFrameProtocolMessage(serializedMessage: string): void {
        let message: FrameProtocolMessage;
        try {
            message = JSON.parse(serializedMessage) as FrameProtocolMessage;
        } catch {
            return;
        }
        if (typeof message.sequenceNo !== "number") return;
        const pending = this.pendingFrames.get(message.sequenceNo);
        if (message.type === "frame_ack") {
            if (message.sequenceNo < this.highestAcknowledgedSequence) this.acknowledgementOrderValid = false;
            this.highestAcknowledgedSequence = Math.max(this.highestAcknowledgedSequence, message.sequenceNo);
            this.pendingFrames.delete(message.sequenceNo);
            this.metrics.increment("acknowledgements");
            return;
        }
        if (message.type !== "frame_nack") return;
        this.metrics.increment("negativeAcknowledgements");
        if (!pending || message.retryable !== true || pending.retransmissions >= 3 || this.socket?.readyState !== WebSocket.OPEN) return;
        pending.retransmissions += 1;
        this.socket.send(pending.payload);
        this.metrics.increment("retransmissions");
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
        if (this.config.faultInjection.has("ws-reconnect")) {
            const socket = this.socket;
            socket?.close(1000, "load-test reconnect");
            await onceClose(socket);
            await this.reconnectPromise;
        }
        if (this.config.faultInjection.has("signalr-reconnect") && this.connection) {
            await this.connection.stop();
            this.metrics.increment("signalRReconnects");
            await this.connection.start();
            await this.connection.invoke("JoinSession", this.sessionId);
        }
    }

    private handleUnexpectedFrameSocketClose(socket: WebSocket): void {
        if (!this.maintainFrameSocket || this.socket !== socket) return;
        this.metrics.increment("webSocketConnectionFailures");
        this.reconnectPromise ??= this.reconnectFrameSocket();
    }

    private async reconnectFrameSocket(): Promise<void> {
        try {
            for (let attempt = 1; attempt <= 5 && this.maintainFrameSocket; attempt += 1) {
                await delay(500 * 2 ** (attempt - 1));
                try {
                    await this.connectFrameSocket(true);
                    return;
                } catch {
                    // The connection failure counter is updated by connectFrameSocket.
                }
            }
        } finally {
            this.reconnectPromise = undefined;
        }
    }

    private async close(): Promise<void> {
        this.maintainFrameSocket = false;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            const socket = this.socket;
            socket.close(1000, "load-test complete");
            await onceClose(socket);
        }
        if (this.connection) await this.connection.stop();
    }
}

async function main(): Promise<void> {
    const config = loadConfig();
    const fixture = await readJpegFixture(config.frameFixture);
    await confirmAzureLoadTest(config, fixture.byteLength);

    const metrics = new Metrics();
    const startedAt = Date.now();
    const sessions = Array.from({ length: config.concurrentSessions }, () => new VirtualSession(config, fixture.toString("base64"), metrics));
    const rampIntervalMs = config.concurrentSessions > 1 ? (config.rampUpSeconds * 1000) / (config.concurrentSessions - 1) : 0;
    const results = await Promise.allSettled(sessions.map((session, index) => session.run(Math.round(index * rampIntervalMs))));
    const assertions: RunAssertions = {
        sessionIsolation: metrics.summarize(0).crossSessionDeliveries === 0,
        sameSessionAcknowledgementOrder: sessions.every((session) => session.acknowledgementOrderIsValid),
        parallelSessionsActivated: config.concurrentSessions < 2 || metrics.summarize(0).sessionsCreated >= 2,
    };
    const report: Report = {
        schemaVersion: 1,
        completedAt: new Date().toISOString(),
        configuration: {
            targetKind: isAzureHttpsEndpoint(config.apiBaseUrl) ? "azure" : "local",
            concurrentSessions: config.concurrentSessions,
            durationSeconds: config.durationSeconds,
            framesPerSecond: config.framesPerSecond,
            rampUpSeconds: config.rampUpSeconds,
            resultTimeoutSeconds: config.resultTimeoutSeconds,
            maxInFlightFrames: config.maxInFlightFrames,
            faultInjection: [...config.faultInjection],
        },
        summary: metrics.summarize(Date.now() - startedAt),
        assertions,
    };
    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    // No target URL, principal, cookie, token, student ID, or frame content is emitted.
    output.write(`${JSON.stringify(report.summary)}\n`);
    if (results.some((result) => result.status === "rejected") || !assertions.sessionIsolation || !assertions.sameSessionAcknowledgementOrder) {
        process.exitCode = 1;
    }
}

async function confirmAzureLoadTest(config: LoadTestConfig, fixtureBytes: number): Promise<void> {
    if (!isAzureHttpsEndpoint(config.apiBaseUrl)) return;
    const estimatedFrames = Math.ceil(config.concurrentSessions * config.durationSeconds * config.framesPerSecond);
    const estimatedUploadMiB = (estimatedFrames * fixtureBytes * 4 / 3) / (1024 * 1024);
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

function toWebSocketUrl(httpUrl: string): string {
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
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

function onceOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolveOpen, rejectOpen) => {
        const onOpen = () => { cleanup(); resolveOpen(); };
        const onError = () => { cleanup(); rejectOpen(new Error("WebSocket error")); };
        const cleanup = () => {
            socket.off("open", onOpen);
            socket.off("error", onError);
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
    });
}

function onceClose(socket: WebSocket | undefined): Promise<void> {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolveClose) => socket.once("close", () => resolveClose()));
}

void main().catch(() => {
    // Deliberately avoid serializing errors because they may contain sensitive request details.
    output.write("Load test failed before completion. Check configuration and service health.\n");
    process.exitCode = 1;
});
