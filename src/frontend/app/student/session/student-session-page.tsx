"use client";

import {
    SyntheticEvent,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { PauseIcon, PlayIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import {
    StoredStudentSession,
    studentSessionStorageKey,
} from "../student-session-storage";

type StudentScreenState =
    | "idle"
    | "starting"
    | "camera_permission_required"
    | "calibration_ready"
    | "calibrating"
    | "ready"
    | "ws_connecting"
    | "streaming"
    | "paused"
    | "error";

type ServiceCheckState = "idle" | "checking" | "ready" | "error";

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";
const frameIntervalMs = 200;
const framesPerIFrame = 5;
const calibrationDurationMs = 5000;
const fallbackLessonDurationSec = 300;
const lessonVideoUrl =
    process.env.NEXT_PUBLIC_LESSON_VIDEO_URL ??
    "http://127.0.0.1:10000/devstoreaccount1/lesson-videos/sample.mp4";
const backendHealthUrl =
    process.env.NEXT_PUBLIC_BACKEND_HEALTH_URL ??
    buildBackendHealthUrl(apiBaseUrl);
const workerHealthUrl =
    process.env.NEXT_PUBLIC_WORKER_HEALTH_URL ?? "http://localhost:8000/health";
const serviceHealthCheckTimeoutMs = 3000;
const maxWebSocketConnectAttempts = 5;
const webSocketBackoffBaseMs = 500;

export default function StudentSessionPage() {
    const router = useRouter();
    const [studentId, setStudentId] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [screenState, setScreenState] = useState<StudentScreenState>("camera_permission_required");
    const [message, setMessage] = useState<string | null>(null);
    const [sentFrames, setSentFrames] = useState(0);
    const [isLoadingOpen, setIsLoadingOpen] = useState(false);
    const [isCalibrationOpen, setIsCalibrationOpen] = useState(false);
    const [isCalibrationDone, setIsCalibrationDone] = useState(false);
    const [calibrationProgress, setCalibrationProgress] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackPosition, setPlaybackPosition] = useState(0);
    const [lessonDurationSec, setLessonDurationSec] = useState(
        fallbackLessonDurationSec,
    );
    const [isWebSocketConnecting, setIsWebSocketConnecting] = useState(false);
    const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
    const [webSocketConnectAttempt, setWebSocketConnectAttempt] = useState(0);
    const [isWebSocketErrorOpen, setIsWebSocketErrorOpen] = useState(false);
    const [serviceCheckState, setServiceCheckState] =
        useState<ServiceCheckState>("idle");
    const [serviceCheckMessage, setServiceCheckMessage] = useState("");

    const lessonVideoRef = useRef<HTMLVideoElement | null>(null);
    const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
        null,
    );
    const playbackIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
        null,
    );
    const calibrationIntervalRef = useRef<ReturnType<
        typeof setInterval
    > | null>(null);
    const webSocketRetryTimeoutRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    const webSocketConnectionIdRef = useRef(0);
    const activeSessionIdRef = useRef<string | null>(null);
    const sequenceNoRef = useRef(1);
    const baseIFrameSequenceNoRef = useRef(1);
    const sendingRef = useRef(false);
    const isPlayingRef = useRef(false);
    const pendingPlaybackAfterSocketOpenRef = useRef(false);

    useEffect(() => {
        return () => {
            stopFrameSending();
            stopPlaybackTimer();
            stopCalibrationTimer();
            clearWebSocketRetryTimer();
            socketRef.current?.close();
            streamRef.current?.getTracks().forEach((track) => track.stop());
        };
    }, []);

    const setCameraVideoElement = useCallback(
        (element: HTMLVideoElement | null) => {
            cameraVideoRef.current = element;

            if (element && streamRef.current) {
                attachStreamToVideo(element, streamRef.current);
            }
        },
        [],
    );

    useEffect(() => {
        if (isCalibrationOpen) {
            attachStreamToCameraVideo();
        }
    }, [isCalibrationOpen]);

    useEffect(() => {
        let isActive = true;

        async function prepareSessionPage() {
            await Promise.resolve();

            if (!isActive) {
                return;
            }

            const storedSession = readStoredStudentSession();

            if (!storedSession) {
                setScreenState("error");
                setMessage(
                    "受講セッションが見つかりません。ログインページから受講を開始してください。",
                );
                return;
            }

            setStudentId(storedSession.studentId);
            setSessionId(storedSession.sessionId);
            setScreenState("camera_permission_required");
            setMessage("カメラ権限を許可してください。");

            try {
                const stream = await requestCameraStream();

                if (!isActive) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }

                activeSessionIdRef.current = storedSession.sessionId;
                attachCameraStream(stream);
                setMessage(null);
                setIsLoadingOpen(true);
                setServiceCheckState("checking");
                setServiceCheckMessage(
                    "Backend と Worker の起動状態を確認しています。",
                );

                const readiness = await checkCalibrationServices();
                if (!isActive) return;

                if (!readiness.ok) {
                    setServiceCheckState("error");
                    setServiceCheckMessage(readiness.message);
                    return;
                }

                setIsLoadingOpen(false);
                setIsCalibrationOpen(true);
                setScreenState("calibration_ready");
                connectFrameSocketWithRetry(
                    storedSession.sessionId,
                    stream,
                    false,
                );
            } catch (error) {
                const errorMessage =
                    error instanceof Error
                        ? error.message
                        : "復旧不能なエラーが発生しました。";
                const isPermissionError =
                    error instanceof DOMException &&
                    (error.name === "NotAllowedError" ||
                        error.name === "PermissionDeniedError");

                setScreenState(
                    isPermissionError
                        ? "camera_permission_required"
                        : "error",
                );
                setMessage(
                    isPermissionError
                        ? "カメラ権限が必要です。ブラウザの権限設定でカメラを許可してから再試行してください。"
                        : errorMessage,
                );
            }
        }

        void prepareSessionPage();

        return () => {
            isActive = false;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- bootstrap once from sessionStorage after route transition

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
        attachStreamToCameraVideo();
    }

    function attachStreamToCameraVideo() {
        const video = cameraVideoRef.current;
        const stream = streamRef.current;

        if (!video || !stream) {
            return;
        }

        attachStreamToVideo(video, stream);
    }

    async function retryLoadingServiceCheck() {
        const activeSessionId = activeSessionIdRef.current;
        const stream = streamRef.current;

        if (!activeSessionId || !stream) {
            setServiceCheckState("error");
            setServiceCheckMessage(
                "セッションまたはカメラが初期化されていません。",
            );
            return;
        }

        setServiceCheckState("checking");
        setServiceCheckMessage(
            "Backend と Worker の起動状態を確認しています。",
        );

        const readiness = await checkCalibrationServices();

        if (!readiness.ok) {
            setServiceCheckState("error");
            setServiceCheckMessage(readiness.message);
            return;
        }

        setIsLoadingOpen(false);
        setIsCalibrationOpen(true);
        setScreenState("calibration_ready");
        connectFrameSocketWithRetry(activeSessionId, stream, false);
    }

    function startCalibration() {
        stopCalibrationTimer();
        setCalibrationProgress(0);
        setScreenState("calibrating");

        const startedAt = Date.now();
        calibrationIntervalRef.current = setInterval(() => {
            const elapsed = Date.now() - startedAt;
            const progress = Math.min(
                (elapsed / calibrationDurationMs) * 100,
                100,
            );
            setCalibrationProgress(progress);

            if (progress >= 100) {
                completeCalibration();
            }
        }, 100);
    }

    function completeCalibration() {
        stopCalibrationTimer();
        setCalibrationProgress(100);
        setIsCalibrationOpen(false);
        setIsCalibrationDone(true);
        setScreenState("ready");
        startPlayback();
    }

    function stopCalibrationTimer() {
        if (calibrationIntervalRef.current) {
            clearInterval(calibrationIntervalRef.current);
            calibrationIntervalRef.current = null;
        }
    }

    function startPlayback() {
        if (!sessionId || !streamRef.current) {
            setScreenState("error");
            setMessage(
                "受講セッションまたはカメラ映像が初期化されていません。",
            );
            return;
        }

        if (socketRef.current?.readyState === WebSocket.OPEN) {
            beginPlaybackAfterSocketOpen(sessionId, streamRef.current);
            return;
        }

        connectFrameSocketWithRetry(sessionId, streamRef.current, true);
    }

    function beginPlaybackAfterSocketOpen(
        activeSessionId: string,
        stream: MediaStream,
    ) {
        isPlayingRef.current = true;
        setIsPlaying(true);
        setScreenState("streaming");
        if (lessonVideoRef.current) {
            safelyPlayVideo(lessonVideoRef.current);
        }
        startPlaybackTimer();
        startFrameSending(activeSessionId, stream);
    }

    function pausePlayback() {
        webSocketConnectionIdRef.current += 1;
        pendingPlaybackAfterSocketOpenRef.current = false;
        clearWebSocketRetryTimer();
        setIsWebSocketConnecting(false);
        isPlayingRef.current = false;
        setIsPlaying(false);
        setScreenState("paused");
        lessonVideoRef.current?.pause();
        stopPlaybackTimer();
        stopFrameSending();
    }

    function togglePlayback() {
        if (isPlaying) {
            pausePlayback();
            return;
        }

        startPlayback();
    }

    function startPlaybackTimer() {
        stopPlaybackTimer();
        playbackIntervalRef.current = setInterval(() => {
            setPlaybackPosition((current) => {
                const video = lessonVideoRef.current;
                const duration = getLessonDuration(video, lessonDurationSec);
                const nextPosition = video
                    ? Math.floor(video.currentTime)
                    : current + 1;

                if (nextPosition >= duration) {
                    stopPlaybackTimer();
                    stopFrameSending();
                    isPlayingRef.current = false;
                    setIsPlaying(false);
                    setScreenState("ready");
                    return duration;
                }
                return nextPosition;
            });
        }, 1000);
    }

    function handleLessonMetadataLoaded(
        event: SyntheticEvent<HTMLVideoElement>,
    ) {
        const duration = getLessonDuration(
            event.currentTarget,
            fallbackLessonDurationSec,
        );
        setLessonDurationSec(duration);
    }

    function handleLessonEnded() {
        stopPlaybackTimer();
        stopFrameSending();
        isPlayingRef.current = false;
        setIsPlaying(false);
        setPlaybackPosition(lessonDurationSec);
        setScreenState("ready");
    }

    function stopPlaybackTimer() {
        if (playbackIntervalRef.current) {
            clearInterval(playbackIntervalRef.current);
            playbackIntervalRef.current = null;
        }
    }

    function connectFrameSocketWithRetry(
        activeSessionId: string,
        stream: MediaStream,
        startPlaybackOnOpen: boolean,
    ) {
        pendingPlaybackAfterSocketOpenRef.current = startPlaybackOnOpen;

        if (socketRef.current?.readyState === WebSocket.OPEN) {
            setIsWebSocketConnected(true);
            if (startPlaybackOnOpen) {
                beginPlaybackAfterSocketOpen(activeSessionId, stream);
            }
            return;
        }

        if (socketRef.current?.readyState === WebSocket.CONNECTING) {
            if (startPlaybackOnOpen) {
                setScreenState("ws_connecting");
            }
            return;
        }

        const connectionId = webSocketConnectionIdRef.current + 1;
        webSocketConnectionIdRef.current = connectionId;
        setIsWebSocketErrorOpen(false);
        attemptFrameSocketConnection(
            activeSessionId,
            stream,
            1,
            connectionId,
            startPlaybackOnOpen,
        );
    }

    function attemptFrameSocketConnection(
        activeSessionId: string,
        stream: MediaStream,
        attempt: number,
        connectionId: number,
        showConnectingState: boolean,
    ) {
        clearWebSocketRetryTimer();
        socketRef.current?.close();
        socketRef.current = null;
        setIsWebSocketConnected(false);
        stopFrameSending();
        setIsWebSocketConnecting(true);
        setWebSocketConnectAttempt(attempt);
        if (showConnectingState) {
            setScreenState("ws_connecting");
        }

        const wsUrl = buildFrameWebSocketUrl(activeSessionId);
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;
        let settled = false;

        socket.addEventListener("open", () => {
            if (connectionId !== webSocketConnectionIdRef.current) {
                socket.close();
                return;
            }

            settled = true;
            setIsWebSocketConnecting(false);
            setIsWebSocketConnected(true);
            setWebSocketConnectAttempt(0);

            if (pendingPlaybackAfterSocketOpenRef.current) {
                pendingPlaybackAfterSocketOpenRef.current = false;
                beginPlaybackAfterSocketOpen(activeSessionId, stream);
            }
        });

        socket.addEventListener("close", () => {
            setIsWebSocketConnected(false);
            stopFrameSending();
            if (!settled && connectionId === webSocketConnectionIdRef.current) {
                scheduleFrameSocketRetry(
                    activeSessionId,
                    stream,
                    attempt,
                    connectionId,
                    showConnectingState,
                );
            }
        });

        socket.addEventListener("error", () => {
            if (!settled) {
                socket.close();
            }
        });
    }

    function scheduleFrameSocketRetry(
        activeSessionId: string,
        stream: MediaStream,
        attempt: number,
        connectionId: number,
        showConnectingState: boolean,
    ) {
        if (attempt >= maxWebSocketConnectAttempts) {
            setIsWebSocketConnecting(false);
            setIsWebSocketConnected(false);
            setWebSocketConnectAttempt(0);
            isPlayingRef.current = false;
            setIsPlaying(false);
            stopPlaybackTimer();
            stopFrameSending();
            setScreenState("error");
            setMessage(
                "WebSocket 接続に失敗しました。ネットワークまたはバックエンドの起動状態を確認してください。",
            );
            setIsWebSocketErrorOpen(true);
            return;
        }

        const delayMs = webSocketBackoffBaseMs * 2 ** (attempt - 1);
        webSocketRetryTimeoutRef.current = setTimeout(() => {
            attemptFrameSocketConnection(
                activeSessionId,
                stream,
                attempt + 1,
                connectionId,
                showConnectingState,
            );
        }, delayMs);
    }

    function clearWebSocketRetryTimer() {
        if (webSocketRetryTimeoutRef.current) {
            clearTimeout(webSocketRetryTimeoutRef.current);
            webSocketRetryTimeoutRef.current = null;
        }
    }

    function buildFrameWebSocketUrl(activeSessionId: string) {
        const baseUrl = new URL(apiBaseUrl);
        baseUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
        baseUrl.pathname = `/ws/sessions/${activeSessionId}/frames`;
        baseUrl.search = "";
        return baseUrl.toString();
    }

    function startFrameSending(activeSessionId: string, stream: MediaStream) {
        stopFrameSending();

        const videoTrack = stream.getVideoTracks()[0];
        const settings = videoTrack?.getSettings();
        const width = settings?.width ?? 640;
        const height = settings?.height ?? 480;

        const canvas = canvasRef.current ?? document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvasRef.current = canvas;

        sequenceNoRef.current = 1;
        baseIFrameSequenceNoRef.current = 1;
        setSentFrames(0);

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
        const socket = socketRef.current;
        const video = cameraVideoRef.current;

        if (
            sendingRef.current ||
            !isPlayingRef.current ||
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
        } finally {
            sendingRef.current = false;
        }
    }

    function canvasToBase64(canvas: HTMLCanvasElement) {
        return new Promise<string>((resolve, reject) => {
            canvas.toBlob(
                (blob) => {
                    if (!blob) {
                        reject(
                            new Error(
                                "フレーム画像のエンコードに失敗しました。",
                            ),
                        );
                        return;
                    }

                    const reader = new FileReader();
                    reader.addEventListener("load", () => {
                        const result = reader.result;
                        if (typeof result !== "string") {
                            reject(
                                new Error(
                                    "フレーム画像の読み込みに失敗しました。",
                                ),
                            );
                            return;
                        }

                        resolve(result.substring(result.indexOf(",") + 1));
                    });
                    reader.addEventListener("error", () =>
                        reject(
                            new Error("フレーム画像の読み込みに失敗しました。"),
                        ),
                    );
                    reader.readAsDataURL(blob);
                },
                "image/jpeg",
                0.72,
            );
        });
    }

    const hasError =
        screenState === "error" || screenState === "camera_permission_required";

    return (
        <main className="relative h-screen w-screen overflow-hidden">
            <video
                ref={lessonVideoRef}
                src={isCalibrationDone ? lessonVideoUrl : undefined}
                className="h-full w-full object-cover"
                playsInline
                preload="metadata"
                onLoadedMetadata={handleLessonMetadataLoaded}
                onEnded={handleLessonEnded}
            />

            <div className="absolute top-4 right-4 flex gap-2">
                {studentId && <Badge variant="secondary">{studentId}</Badge>}
                <Badge>{isPlaying ? "カメラ録画中" : "カメラ待機中"}</Badge>
                <Badge variant="secondary">送信 {sentFrames}</Badge>
                <Badge variant="secondary">
                    WS{isWebSocketConnected ? "接続済み" : "未接続"}
                </Badge>
            </div>

            <div className="absolute right-6 bottom-6 left-6 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                    <Button
                        type="button"
                        size="icon"
                        aria-label={isPlaying ? "動画を一時停止" : "動画を再生"}
                        onClick={togglePlayback}
                        disabled={
                            isCalibrationOpen ||
                            !sessionId ||
                            isWebSocketConnecting ||
                            screenState === "error" ||
                            screenState === "camera_permission_required"
                        }
                    >
                        {isPlaying ? (
                            <PauseIcon aria-hidden="true" />
                        ) : (
                            <PlayIcon aria-hidden="true" />
                        )}
                    </Button>
                    <Slider
                        value={[playbackPosition]}
                        max={lessonDurationSec}
                        disabled
                    />
                </div>
                <div className="flex justify-end gap-4">
                    <span>
                        {formatTime(playbackPosition)}/
                        {formatTime(lessonDurationSec)}
                    </span>
                </div>
            </div>

            {message && hasError && (
                <div className="absolute top-16 left-1/2 w-full max-w-md -translate-x-1/2 px-4">
                    <Alert
                        variant={
                            screenState === "error" ? "destructive" : "default"
                        }
                    >
                        <AlertTitle>
                            {screenState === "error" ? "確認してください" : "状態"}
                        </AlertTitle>
                        <AlertDescription className="flex flex-col gap-3">
                            <span>{message}</span>
                            {screenState === "error" && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => router.push("/student")}
                                >
                                    ログインページへ戻る
                                </Button>
                            )}
                        </AlertDescription>
                    </Alert>
                </div>
            )}

            {isWebSocketConnecting && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2">
                        <Spinner />
                        <span>接続中</span>
                        <span>
                            {webSocketConnectAttempt}/
                            {maxWebSocketConnectAttempts}
                        </span>
                    </div>
                </div>
            )}

            <Dialog
                open={isWebSocketErrorOpen}
                onOpenChange={setIsWebSocketErrorOpen}
            >
                <DialogContent className="w-full max-w-md">
                    <DialogHeader>
                        <DialogTitle>WebSocket 接続エラー</DialogTitle>
                        <DialogDescription>
                            WebSocket
                            接続を5回試行しましたが失敗しました。ネットワークまたはバックエンドの起動状態を確認してください。
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsWebSocketErrorOpen(false)}
                        >
                            閉じる
                        </Button>
                        <Button
                            onClick={() => {
                                setIsWebSocketErrorOpen(false);
                                startPlayback();
                            }}
                        >
                            再試行
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={isLoadingOpen}>
                <DialogContent
                    showCloseButton={false}
                    className="w-full max-w-md"
                >
                    <DialogHeader>
                        <DialogTitle>接続確認</DialogTitle>
                        <DialogDescription>
                            {serviceCheckState === "error"
                                ? "サービスへの接続に失敗しました。"
                                : "Backend と Worker への接続を確認しています。"}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col items-center gap-4 py-2">
                        {serviceCheckState === "checking" && (
                            <>
                                <Spinner />
                                <span className="text-sm text-muted-foreground">
                                    {serviceCheckMessage}
                                </span>
                            </>
                        )}
                        {serviceCheckState === "error" && (
                            <Alert variant="destructive" className="w-full">
                                <AlertTitle>接続エラー</AlertTitle>
                                <AlertDescription>
                                    {serviceCheckMessage}
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>

                    {serviceCheckState === "error" && (
                        <DialogFooter>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    setIsLoadingOpen(false);
                                    router.push("/student");
                                }}
                            >
                                ログインページへ戻る
                            </Button>
                            <Button
                                onClick={() => void retryLoadingServiceCheck()}
                            >
                                再試行
                            </Button>
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={isCalibrationOpen}>
                <DialogContent
                    showCloseButton={false}
                    className="w-full max-w-xl"
                >
                    <DialogHeader>
                        <DialogTitle>キャリブレーション</DialogTitle>
                        <DialogDescription>
                            カメラ画角を確認し、開始ボタンを押してください。5秒間、顔を正面に向けてください。
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-4">
                        <video
                            ref={setCameraVideoElement}
                            className="aspect-4/3 w-full object-cover"
                            muted
                            playsInline
                        />
                        {screenState === "calibrating" && (
                            <>
                                <Progress value={calibrationProgress} />
                                <div className="flex justify-end">
                                    <span className="text-sm text-muted-foreground">
                                        {Math.round(calibrationProgress)}%
                                    </span>
                                </div>
                            </>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            onClick={startCalibration}
                            disabled={screenState === "calibrating"}
                        >
                            {screenState === "calibrating"
                                ? "キャリブレーション中..."
                                : "開始"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </main>
    );
}

function readStoredStudentSession() {
    const storedSession = sessionStorage.getItem(studentSessionStorageKey);
    if (!storedSession) {
        return null;
    }

    try {
        const parsed = JSON.parse(storedSession) as Partial<StoredStudentSession>;
        if (typeof parsed.sessionId !== "string" || typeof parsed.studentId !== "string") {
            return null;
        }

        return {
            sessionId: parsed.sessionId,
            studentId: parsed.studentId,
        } satisfies StoredStudentSession;
    } catch {
        return null;
    }
}

function attachStreamToVideo(video: HTMLVideoElement, stream: MediaStream) {
    if (video.srcObject !== stream) {
        video.srcObject = stream;
    }

    if (video.paused) {
        safelyPlayVideo(video);
    }
}

function safelyPlayVideo(video: HTMLVideoElement) {
    void video.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
            return;
        }

        console.warn("動画の再生を開始できませんでした。", error);
    });
}

function getLessonDuration(
    video: HTMLVideoElement | null,
    fallbackDurationSec: number,
) {
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
        return fallbackDurationSec;
    }

    return Math.floor(video.duration);
}

async function checkCalibrationServices() {
    const results = await Promise.all([
        checkServiceHealth("Backend", backendHealthUrl),
        checkServiceHealth("Worker", workerHealthUrl),
    ]);
    const failedResults = results.filter((result) => !result.ok);

    if (failedResults.length === 0) {
        return { ok: true } as const;
    }

    const detail = failedResults
        .map((result) => `${result.name}: ${result.reason}`)
        .join(" / ");

    return {
        ok: false,
        message: `${detail}。Backend と Worker を起動してから再試行してください。`,
    } as const;
}

async function checkServiceHealth(name: string, url: string) {
    try {
        const response = await fetchWithTimeout(
            url,
            serviceHealthCheckTimeoutMs,
        );

        if (!response.ok) {
            return {
                name,
                ok: false,
                reason: `HTTP ${response.status}`,
            } as const;
        }

        return { name, ok: true } as const;
    } catch (error) {
        const reason =
            error instanceof DOMException && error.name === "AbortError"
                ? "タイムアウト"
                : "応答なし";

        return { name, ok: false, reason } as const;
    }
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    try {
        return await fetch(url, {
            cache: "no-store",
            signal: abortController.signal,
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildBackendHealthUrl(baseUrl: string) {
    const url = new URL(baseUrl);
    url.pathname = "/WeatherForecast";
    url.search = "";
    return url.toString();
}

function formatTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
