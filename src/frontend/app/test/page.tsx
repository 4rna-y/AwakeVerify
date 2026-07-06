"use client";

import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";
const frameIntervalMs = 200;
const framesPerIFrame = 5;
const maxRecentEvents = 20;

type RuntimeState = "idle" | "starting" | "running" | "paused" | "error";
type SocketState = "idle" | "connecting" | "connected" | "closed" | "error";
type ResultStreamState =
    | "idle"
    | "connecting"
    | "connected"
    | "closed"
    | "error";
type DrowsinessLevel = "normal" | "caution" | "warning" | "danger";

type StartSessionResponse = {
    sessionId: string;
};

type DrowsinessScoreEvent = {
    type: "drowsiness_score";
    sessionId: string;
    scoredAt: string;
    score: number;
    level: DrowsinessLevel;
    perclos: number;
    ear: number;
    pitchDeg: number;
    yawDeg: number;
    shouldPause: boolean;
};

type TrackingStatusEvent = {
    type: "tracking_status";
    sessionId: string;
    detectedAt: string;
    status: "face_not_detected";
};

type AnalysisEvent = DrowsinessScoreEvent | TrackingStatusEvent;

export default function WorkerPipelineTestPage() {
    const [studentId, setStudentId] = useState(() => buildDefaultStudentId());
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [runtimeState, setRuntimeState] = useState<RuntimeState>("idle");
    const [frameSocketState, setFrameSocketState] =
        useState<SocketState>("idle");
    const [resultStreamState, setResultStreamState] =
        useState<ResultStreamState>("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [sentFrames, setSentFrames] = useState(0);
    const [latestScore, setLatestScore] = useState<DrowsinessScoreEvent | null>(
        null,
    );
    const [latestTracking, setLatestTracking] =
        useState<TrackingStatusEvent | null>(null);
    const [recentEvents, setRecentEvents] = useState<AnalysisEvent[]>([]);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const frameSocketRef = useRef<WebSocket | null>(null);
    const resultEventSourceRef = useRef<EventSource | null>(null);
    const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sequenceNoRef = useRef(1);
    const baseIFrameSequenceNoRef = useRef(1);
    const sendingRef = useRef(false);
    const runningRef = useRef(false);

    useEffect(() => {
        return () => {
            runningRef.current = false;
            if (frameIntervalRef.current) {
                clearInterval(frameIntervalRef.current);
                frameIntervalRef.current = null;
            }
            frameSocketRef.current?.close();
            resultEventSourceRef.current?.close();
            streamRef.current?.getTracks().forEach((track) => track.stop());
        };
    }, []);

    async function startPipeline() {
        setRuntimeState("starting");
        setMessage(null);
        setLatestScore(null);
        setLatestTracking(null);
        setRecentEvents([]);
        setSentFrames(0);

        try {
            const activeSessionId = await createSession(studentId);
            setSessionId(activeSessionId);

            const stream = await requestCameraStream();
            attachCameraStream(stream);

            connectResultStream(activeSessionId);
            connectFrameSocket(activeSessionId);
        } catch (error) {
            setRuntimeState("error");
            setMessage(toErrorMessage(error));
            stopPipeline();
        }
    }

    function pausePipeline() {
        runningRef.current = false;
        setRuntimeState("paused");
        stopFrameSending();
    }

    function resumePipeline() {
        const activeSessionId = sessionId;
        if (!activeSessionId || frameSocketRef.current?.readyState !== WebSocket.OPEN) {
            setRuntimeState("error");
            setMessage("セッションまたはフレーム送信用 WebSocket が初期化されていません。");
            return;
        }

        runningRef.current = true;
        setRuntimeState("running");
        startFrameSending(activeSessionId);
    }

    function stopPipeline() {
        runningRef.current = false;
        stopFrameSending();
        frameSocketRef.current?.close();
        frameSocketRef.current = null;
        resultEventSourceRef.current?.close();
        resultEventSourceRef.current = null;
        setFrameSocketState((current) =>
            current === "idle" ? "idle" : "closed",
        );
        setResultStreamState((current) =>
            current === "idle" ? "idle" : "closed",
        );
        setRuntimeState((current) => (current === "idle" ? "idle" : "paused"));
    }

    async function createSession(activeStudentId: string) {
        const response = await fetch(`${apiBaseUrl}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: activeStudentId.trim() }),
        });

        if (!response.ok) {
            throw new Error(`セッション作成に失敗しました。HTTP ${response.status}`);
        }

        const payload = (await response.json()) as Partial<StartSessionResponse>;
        if (!payload.sessionId) {
            throw new Error("セッション作成レスポンスに sessionId がありません。");
        }

        return payload.sessionId;
    }

    async function requestCameraStream() {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error("このブラウザはカメラ取得に対応していません。");
        }

        return navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 5, max: 5 },
                facingMode: "user",
            },
            audio: false,
        });
    }

    function attachCameraStream(stream: MediaStream) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) {
            return;
        }

        video.srcObject = stream;
        void video.play().catch((error: unknown) => {
            console.warn("カメラプレビューを開始できませんでした。", error);
        });
    }

    function connectFrameSocket(activeSessionId: string) {
        frameSocketRef.current?.close();
        setFrameSocketState("connecting");

        const socket = new WebSocket(buildFrameWebSocketUrl(activeSessionId));
        frameSocketRef.current = socket;

        socket.addEventListener("open", () => {
            setFrameSocketState("connected");
            setRuntimeState("running");
            runningRef.current = true;
            startFrameSending(activeSessionId);
        });

        socket.addEventListener("close", () => {
            setFrameSocketState("closed");
            runningRef.current = false;
            stopFrameSending();
            setRuntimeState((current) =>
                current === "running" || current === "starting" ? "paused" : current,
            );
        });

        socket.addEventListener("error", () => {
            setFrameSocketState("error");
            setRuntimeState("error");
            setMessage("フレーム送信用 WebSocket でエラーが発生しました。");
        });
    }

    function connectResultStream(activeSessionId: string) {
        resultEventSourceRef.current?.close();
        setResultStreamState("connecting");

        const eventSource = new EventSource(buildAnalysisEventsUrl(activeSessionId));
        resultEventSourceRef.current = eventSource;

        eventSource.addEventListener("open", () => {
            setResultStreamState("connected");
        });

        eventSource.addEventListener("message", (event) => {
            const analysisEvent = parseAnalysisEvent(event.data);
            if (!analysisEvent || analysisEvent.sessionId !== activeSessionId) {
                return;
            }

            if (analysisEvent.type === "drowsiness_score") {
                setLatestScore(analysisEvent);
            } else {
                setLatestTracking(analysisEvent);
            }

            setRecentEvents((current) =>
                [analysisEvent, ...current].slice(0, maxRecentEvents),
            );
        });

        eventSource.addEventListener("error", () => {
            setResultStreamState("error");
        });
    }

    function startFrameSending(activeSessionId: string) {
        stopFrameSending();

        const canvas = canvasRef.current ?? document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        canvasRef.current = canvas;
        sequenceNoRef.current = 1;
        baseIFrameSequenceNoRef.current = 1;

        frameIntervalRef.current = setInterval(() => {
            void captureAndSendFrame(activeSessionId, canvas);
        }, frameIntervalMs);
    }

    function stopFrameSending() {
        if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
        }
    }

    async function captureAndSendFrame(
        activeSessionId: string,
        canvas: HTMLCanvasElement,
    ) {
        const socket = frameSocketRef.current;
        const video = videoRef.current;

        if (
            sendingRef.current ||
            !runningRef.current ||
            !socket ||
            socket.readyState !== WebSocket.OPEN ||
            !video ||
            video.readyState < 2
        ) {
            return;
        }

        sendingRef.current = true;
        try {
            const context = canvas.getContext("2d");
            if (!context) {
                throw new Error("Canvas を初期化できませんでした。");
            }

            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const payloadBase64 = await canvasToBase64(canvas);
            const sequenceNo = sequenceNoRef.current;
            const isIFrame = (sequenceNo - 1) % framesPerIFrame === 0;

            if (isIFrame) {
                baseIFrameSequenceNoRef.current = sequenceNo;
            }

            socket.send(
                JSON.stringify({
                    sessionId: activeSessionId,
                    sequenceNo,
                    frameType: isIFrame ? "I" : "P",
                    baseIFrameSequenceNo: baseIFrameSequenceNoRef.current,
                    capturedAt: new Date().toISOString(),
                    codec: "image/jpeg",
                    payloadBase64,
                }),
            );

            sequenceNoRef.current = sequenceNo + 1;
            setSentFrames((current) => current + 1);
        } catch (error) {
            setRuntimeState("error");
            setMessage(toErrorMessage(error));
            runningRef.current = false;
            stopFrameSending();
        } finally {
            sendingRef.current = false;
        }
    }

    const isRunning = runtimeState === "running";
    const isStarting = runtimeState === "starting";
    const canStart = runtimeState === "idle" || runtimeState === "paused" || runtimeState === "error";
    const canResume = runtimeState === "paused" && frameSocketState === "connected";

    return (
        <main className="min-h-screen bg-background p-6 text-foreground">
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                        <h1 className="text-2xl font-semibold">Worker pipeline test</h1>
                        <p className="text-sm text-muted-foreground">
                            カメラフレームを backend の WebSocket へ送信し、worker 解析結果を backend のイベントストリームから表示します。
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">runtime: {runtimeState}</Badge>
                        <Badge variant="secondary">frame WS: {frameSocketState}</Badge>
                        <Badge variant="secondary">result: {resultStreamState}</Badge>
                    </div>
                </div>

                {message && (
                    <Alert variant={runtimeState === "error" ? "destructive" : "default"}>
                        <AlertTitle>状態</AlertTitle>
                        <AlertDescription>{message}</AlertDescription>
                    </Alert>
                )}

                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
                    <Card>
                        <CardHeader>
                            <CardTitle>Camera frame</CardTitle>
                            <CardDescription>
                                640×480 / 5fps 相当の JPEG フレームを送信します。
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                            <div className="overflow-hidden rounded-xl bg-black">
                                <video
                                    ref={videoRef}
                                    className="aspect-4/3 w-full object-cover"
                                    muted
                                    playsInline
                                />
                            </div>

                            <div className="flex flex-col gap-3 rounded-lg border p-3 md:flex-row md:items-center md:justify-between">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="text-muted-foreground">studentId</span>
                                    <input
                                        className="h-9 rounded-md border bg-background px-3 text-sm"
                                        value={studentId}
                                        onChange={(event) => setStudentId(event.target.value)}
                                        disabled={isRunning || runtimeState === "starting"}
                                    />
                                </label>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        onClick={() => void startPipeline()}
                                        disabled={!canStart || isStarting || studentId.trim().length === 0}
                                    >
                                        {isStarting ? "開始中..." : "新規開始"}
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={pausePipeline}
                                        disabled={!isRunning}
                                    >
                                        一時停止
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={resumePipeline}
                                        disabled={!canResume}
                                    >
                                        再開
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={stopPipeline}
                                        disabled={runtimeState === "idle"}
                                    >
                                        停止
                                    </Button>
                                </div>
                            </div>

                            <div className="grid gap-3 text-sm md:grid-cols-3">
                                <StatusItem label="sessionId" value={sessionId ?? "-"} />
                                <StatusItem label="sentFrames" value={sentFrames.toString()} />
                                <StatusItem label="apiBaseUrl" value={apiBaseUrl} />
                            </div>
                        </CardContent>
                    </Card>

                    <div className="flex flex-col gap-6">
                        <Card>
                            <CardHeader>
                                <CardTitle>Latest worker result</CardTitle>
                                <CardDescription>
                                    worker-gui と同じ解析値を backend 経由の通知として表示します。
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3">
                                {latestTracking && (
                                    <Alert>
                                        <AlertTitle>Tracking</AlertTitle>
                                        <AlertDescription>
                                            顔が検出できません。カメラ位置を調整してください。
                                        </AlertDescription>
                                    </Alert>
                                )}

                                {latestScore ? (
                                    <>
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm text-muted-foreground">level</span>
                                            <Badge variant={latestScore.level === "danger" ? "destructive" : "secondary"}>
                                                {latestScore.level}
                                            </Badge>
                                        </div>
                                        <Metric label="EAR" value={latestScore.ear.toFixed(3)} />
                                        <Metric label="Pitch" value={`${latestScore.pitchDeg.toFixed(1)} deg`} />
                                        <Metric label="Yaw" value={`${latestScore.yawDeg.toFixed(1)} deg`} />
                                        <Metric label="PERCLOS" value={latestScore.perclos.toFixed(3)} />
                                        <Metric label="score" value={latestScore.score.toFixed(3)} />
                                        <Metric label="shouldPause" value={String(latestScore.shouldPause)} />
                                        <Metric label="scoredAt" value={formatTime(latestScore.scoredAt)} />
                                    </>
                                ) : (
                                    <p className="text-sm text-muted-foreground">
                                        解析結果待ちです。backend/worker が起動し、worker が同じ sessionId の結果を送信するとここに表示されます。
                                    </p>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Recent events</CardTitle>
                                <CardDescription>最新 {maxRecentEvents} 件の解析イベント</CardDescription>
                            </CardHeader>
                            <CardContent>
                                {recentEvents.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">イベントはまだありません。</p>
                                ) : (
                                    <div className="flex max-h-96 flex-col gap-2 overflow-auto">
                                        {recentEvents.map((event, index) => (
                                            <pre
                                                key={`${event.type}-${index}`}
                                                className="overflow-auto rounded-md bg-muted p-2 text-xs"
                                            >
                                                {JSON.stringify(event, null, 2)}
                                            </pre>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>
        </main>
    );
}

function StatusItem({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="break-all font-mono text-sm">{value}</div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{value}</span>
        </div>
    );
}

function buildDefaultStudentId() {
    return `test-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function buildFrameWebSocketUrl(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/ws/sessions/${sessionId}/frames`;
    url.search = "";
    return url.toString();
}

function buildAnalysisEventsUrl(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.pathname = `/api/sessions/${sessionId}/analysis-events`;
    url.search = "";
    return url.toString();
}

function parseAnalysisEvent(value: string): AnalysisEvent | null {
    try {
        const parsed = JSON.parse(value) as Partial<AnalysisEvent>;
        if (parsed.type === "drowsiness_score" && typeof parsed.sessionId === "string") {
            return parsed as DrowsinessScoreEvent;
        }
        if (parsed.type === "tracking_status" && typeof parsed.sessionId === "string") {
            return parsed as TrackingStatusEvent;
        }
        return null;
    } catch {
        return null;
    }
}

function canvasToBase64(canvas: HTMLCanvasElement) {
    return new Promise<string>((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new Error("フレーム画像のエンコードに失敗しました。"));
                    return;
                }

                const reader = new FileReader();
                reader.addEventListener("load", () => {
                    const result = reader.result;
                    if (typeof result !== "string") {
                        reject(new Error("フレーム画像の読み込みに失敗しました。"));
                        return;
                    }

                    resolve(result.substring(result.indexOf(",") + 1));
                });
                reader.addEventListener("error", () =>
                    reject(new Error("フレーム画像の読み込みに失敗しました。")),
                );
                reader.readAsDataURL(blob);
            },
            "image/jpeg",
            0.72,
        );
    });
}

function toErrorMessage(error: unknown) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
        return "カメラ権限が必要です。ブラウザでカメラを許可してください。";
    }

    return error instanceof Error ? error.message : "不明なエラーが発生しました。";
}

function formatTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return value;
    }
    return date.toLocaleTimeString();
}
