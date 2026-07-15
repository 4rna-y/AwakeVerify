"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

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
const maxRecentEvents = 20;

type RuntimeState = "idle" | "starting" | "running" | "paused" | "error";
type FrameTransportState = "idle" | "sending" | "paused" | "error";
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
    videoTimeSec: number;
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

type CalibrationStatusEvent =
    | {
          type: "calibration_status";
          sessionId: string;
          status: "failed";
          validFrames: number;
          totalFrames: number;
          targetFrames: number;
      }
    | {
          type: "calibration_status";
          sessionId: string;
          status: "succeeded";
          validFrames: number;
          totalFrames: number;
          targetFrames: number;
          sourceSequenceNo: number;
          calibratedAt: string;
          earOpen: number;
          earThreshold: number;
      };

type AnalysisEvent =
    | DrowsinessScoreEvent
    | TrackingStatusEvent
    | CalibrationStatusEvent;

export default function WorkerPipelineTestPage() {
    const [studentId, setStudentId] = useState(() => buildDefaultStudentId());
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [runtimeState, setRuntimeState] = useState<RuntimeState>("idle");
    const [frameTransportState, setFrameTransportState] =
        useState<FrameTransportState>("idle");
    const [resultStreamState, setResultStreamState] =
        useState<ResultStreamState>("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [sentFrames, setSentFrames] = useState(0);
    const [latestScore, setLatestScore] = useState<DrowsinessScoreEvent | null>(
        null,
    );
    const [latestTracking, setLatestTracking] =
        useState<TrackingStatusEvent | null>(null);
    const [calibration, setCalibration] =
        useState<CalibrationStatusEvent | null>(null);
    const [recentEvents, setRecentEvents] = useState<AnalysisEvent[]>([]);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const resultEventSourceRef = useRef<EventSource | null>(null);
    const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const sequenceNoRef = useRef(1);
    const sendingRef = useRef(false);
    const runningRef = useRef(false);

    useEffect(() => {
        return () => {
            runningRef.current = false;
            if (frameIntervalRef.current) {
                clearInterval(frameIntervalRef.current);
                frameIntervalRef.current = null;
            }
            resultEventSourceRef.current?.close();
            streamRef.current?.getTracks().forEach((track) => track.stop());
        };
    }, []);

    async function startPipeline() {
        setRuntimeState("starting");
        setMessage(null);
        setLatestScore(null);
        setLatestTracking(null);
        setCalibration(null);
        setRecentEvents([]);
        setSentFrames(0);

        try {
            const activeSessionId = await createSession(studentId);
            setSessionId(activeSessionId);

            const stream = await requestCameraStream();
            attachCameraStream(stream);

            connectResultStream(activeSessionId);
            runningRef.current = true;
            setFrameTransportState("sending");
            setRuntimeState("running");
            startFrameSending(activeSessionId);
        } catch (error) {
            setRuntimeState("error");
            setMessage(toErrorMessage(error));
            stopPipeline();
        }
    }

    function pausePipeline() {
        runningRef.current = false;
        setRuntimeState("paused");
        setFrameTransportState("paused");
        stopFrameSending();
    }

    function resumePipeline() {
        const activeSessionId = sessionId;
        if (!activeSessionId) {
            setRuntimeState("error");
            setMessage("受講セッションが初期化されていません。");
            return;
        }

        runningRef.current = true;
        setFrameTransportState("sending");
        setRuntimeState("running");
        startFrameSending(activeSessionId);
    }

    function stopPipeline() {
        runningRef.current = false;
        stopFrameSending();
        resultEventSourceRef.current?.close();
        resultEventSourceRef.current = null;
        setFrameTransportState((current) => current === "idle" ? "idle" : "paused");
        setResultStreamState((current) =>
            current === "idle" ? "idle" : "closed",
        );
        setRuntimeState((current) => (current === "idle" ? "idle" : "paused"));
    }

    async function createSession(activeStudentId: string) {
        const response = await apiFetch("/api/sessions", {
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

    function connectResultStream(activeSessionId: string) {
        resultEventSourceRef.current?.close();
        setResultStreamState("connecting");

        const eventSource = new EventSource(buildAnalysisEventsUrl(activeSessionId), {
                    withCredentials: true,
                });
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
            } else if (analysisEvent.type === "tracking_status") {
                setLatestTracking(analysisEvent);
            } else {
                setCalibration(analysisEvent);
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
        const video = videoRef.current;

        if (
            sendingRef.current ||
            !runningRef.current ||
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
            const videoTimeSec = Number.isFinite(video.currentTime) && video.currentTime >= 0 ? video.currentTime : 0;
            const sequenceNo = sequenceNoRef.current;
            sequenceNoRef.current = sequenceNo + 1;
            const jpeg = await canvasToJpeg(canvas);
            const accepted = await postFrame(activeSessionId, sequenceNo, new Date().toISOString(), videoTimeSec, jpeg);
            if (!accepted) throw new Error("フレーム送信が受理されませんでした。");
            setSentFrames((current) => current + 1);
        } catch (error) {
            setRuntimeState("error");
            setMessage(toErrorMessage(error));
            setFrameTransportState("error");
            runningRef.current = false;
            stopFrameSending();
        } finally {
            sendingRef.current = false;
        }
    }

    const isRunning = runtimeState === "running";
    const isStarting = runtimeState === "starting";
    const canStart = runtimeState === "idle" || runtimeState === "paused" || runtimeState === "error";
    const canResume = runtimeState === "paused" && sessionId !== null;

    return (
        <main className="min-h-screen bg-background p-6 text-foreground">
            <div className="mx-auto flex max-w-6xl flex-col gap-6">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                        <h1 className="text-2xl font-semibold">Worker pipeline test</h1>
                        <p className="text-sm text-muted-foreground">
                            カメラフレームを backend の HTTPS binary API へ送信し、worker 解析結果を backend のイベントストリームから表示します。
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Badge variant="secondary">runtime: {runtimeState}</Badge>
                        <Badge variant="secondary">frame HTTP: {frameTransportState}</Badge>
                        <Badge variant="secondary">result: {resultStreamState}</Badge>
                        <Badge variant={calibration?.status === "failed" ? "destructive" : "secondary"}>
                            calibration: {calibration?.status ?? "pending"}
                        </Badge>
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
                                <CardTitle>Calibration</CardTitle>
                                <CardDescription>
                                    開眼状態を基準化し、個人別の閉眼閾値を算出します。
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col gap-3">
                                {calibration?.status === "failed" && (
                                    <Alert variant="destructive">
                                        <AlertTitle>キャリブレーション失敗</AlertTitle>
                                        <AlertDescription>
                                            キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。自動的に再試行します。
                                        </AlertDescription>
                                    </Alert>
                                )}

                                {calibration ? (
                                    <>
                                        <Metric
                                            label="valid/total frames"
                                            value={`${calibration.validFrames} / ${calibration.totalFrames} (target ${calibration.targetFrames})`}
                                        />
                                        {calibration.status === "succeeded" && (
                                            <>
                                                <Metric
                                                    label="EAR_open"
                                                    value={calibration.earOpen.toFixed(3)}
                                                />
                                                <Metric
                                                    label="EAR_threshold"
                                                    value={calibration.earThreshold.toFixed(3)}
                                                />
                                                <Metric
                                                    label="calibratedAt"
                                                    value={formatTime(calibration.calibratedAt)}
                                                />
                                            </>
                                        )}
                                    </>
                                ) : (
                                    <p className="text-sm text-muted-foreground">
                                        パイプライン開始後、5秒間のキャリブレーションが自動的に実施されます。
                                    </p>
                                )}
                            </CardContent>
                        </Card>

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

function buildAnalysisEventsUrl(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.pathname = `/api/sessions/${sessionId}/analysis-events`;
    url.search = "";
    return url.toString();
}

function parseAnalysisEvent(value: string): AnalysisEvent | null {
    try {
        const parsed = JSON.parse(value) as Partial<AnalysisEvent>;
        if (parsed.type === "drowsiness_score" && typeof parsed.sessionId === "string" && typeof parsed.videoTimeSec === "number" && Number.isFinite(parsed.videoTimeSec) && parsed.videoTimeSec >= 0) {
            return parsed as DrowsinessScoreEvent;
        }
        if (parsed.type === "tracking_status" && typeof parsed.sessionId === "string") {
            return parsed as TrackingStatusEvent;
        }
        if (parsed.type === "calibration_status" && typeof parsed.sessionId === "string") {
            return parsed as CalibrationStatusEvent;
        }
        return null;
    } catch {
        return null;
    }
}

function canvasToJpeg(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (!blob) {
                    reject(new Error("フレーム画像のエンコードに失敗しました。"));
                    return;
                }

                resolve(blob);
            },
            "image/jpeg",
            0.72,
        );
    });
}

async function postFrame(
    sessionId: string,
    sequenceNo: number,
    capturedAt: string,
    videoTimeSec: number,
    jpeg: Blob,
): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/frames/${sequenceNo}`, {
            method: "POST",
            headers: {
                "Content-Type": "image/jpeg",
                "X-Frame-Captured-At": capturedAt,
                "X-Frame-Video-Time-Sec": String(videoTimeSec),
            },
            body: jpeg,
        });
        if (response.status === 202) return true;
        if (response.status !== 429 && response.status !== 503) return false;
        if (attempt < 3) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** (attempt - 1)));
    }
    return false;
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
