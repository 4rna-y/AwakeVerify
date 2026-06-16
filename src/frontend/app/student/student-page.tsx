"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";

type LoginMode = "student" | "teacher";
type Screen = "login" | "video";
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

type StartSessionResponse = {
    sessionId: string;
};

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";
const frameIntervalMs = 200;
const framesPerIFrame = 5;
const calibrationDurationMs = 5000;
const lessonDurationSec = 300;
const maxWebSocketConnectAttempts = 5;
const webSocketBackoffBaseMs = 500;

export default function StudentPage() {
    const [loginMode, setLoginMode] = useState<LoginMode>("student");
    const [screen, setScreen] = useState<Screen>("login");
    const [studentId, setStudentId] = useState("");
    const [teacherId, setTeacherId] = useState("");
    const [teacherPassword, setTeacherPassword] = useState("");
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [screenState, setScreenState] = useState<StudentScreenState>("idle");
    const [message, setMessage] = useState<string | null>(null);
    const [sentFrames, setSentFrames] = useState(0);
    const [isCalibrationOpen, setIsCalibrationOpen] = useState(false);
    const [calibrationProgress, setCalibrationProgress] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackPosition, setPlaybackPosition] = useState(0);
    const [isWebSocketConnecting, setIsWebSocketConnecting] = useState(false);
    const [isWebSocketConnected, setIsWebSocketConnected] = useState(false);
    const [webSocketConnectAttempt, setWebSocketConnectAttempt] = useState(0);
    const [isWebSocketErrorOpen, setIsWebSocketErrorOpen] = useState(false);

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

    async function startStudentSession(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const normalizedStudentId = studentId.trim();
        if (!normalizedStudentId) {
            setScreenState("error");
            setMessage("学籍番号を入力してください。");
            return;
        }

        setScreenState("starting");
        setMessage(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/sessions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ studentId: normalizedStudentId }),
            });

            if (!response.ok) {
                throw new Error(
                    `セッション開始に失敗しました: ${response.status}`,
                );
            }

            const data = (await response.json()) as StartSessionResponse;
            setSessionId(data.sessionId);

            const stream = await requestCameraStream();
            attachCameraStream(stream);

            setScreen("video");
            setIsCalibrationOpen(true);
            setScreenState("calibration_ready");
            setMessage(null);
            connectFrameSocketWithRetry(data.sessionId, stream, false);
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
                isPermissionError ? "camera_permission_required" : "error",
            );
            setMessage(
                isPermissionError
                    ? "カメラ権限が必要です。ブラウザの権限設定でカメラを許可してから再試行してください。"
                    : errorMessage,
            );
        }
    }

    function submitTeacherLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setScreenState("error");
        setMessage("教員ログインは後続featureでAPI接続します。");
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
        attachStreamToCameraVideo();
    }

    function attachStreamToCameraVideo() {
        if (cameraVideoRef.current && streamRef.current) {
            cameraVideoRef.current.srcObject = streamRef.current;
            void cameraVideoRef.current.play();
        }
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
        void lessonVideoRef.current?.play();
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
                if (current >= lessonDurationSec) {
                    stopPlaybackTimer();
                    stopFrameSending();
                    isPlayingRef.current = false;
                    setIsPlaying(false);
                    setScreenState("ready");
                    return lessonDurationSec;
                }
                return current + 1;
            });
        }, 1000);
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

    const canSubmitStudent =
        screenState !== "starting" && studentId.trim().length > 0;
    const canSubmitTeacher =
        teacherId.trim().length > 0 && teacherPassword.length > 0;
    const hasError =
        screenState === "error" || screenState === "camera_permission_required";

    return (
        <main className="relative h-screen w-screen overflow-hidden">
            <video
                ref={lessonVideoRef}
                className="h-full w-full object-cover"
                playsInline
            />

            {screen === "video" && (
                <>
                    <div className="absolute top-4 right-4 flex gap-2">
                        <Badge>
                            {isPlaying ? "カメラ録画中" : "カメラ待機中"}
                        </Badge>
                        <Badge variant="secondary">送信 {sentFrames}</Badge>
                        <Badge variant="secondary">
                            WS{isWebSocketConnected ? "接続済み" : "未接続"}
                        </Badge>
                    </div>

                    <div className="absolute right-6 bottom-6 left-6 flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                            <Button
                                onClick={togglePlayback}
                                disabled={
                                    isCalibrationOpen ||
                                    !sessionId ||
                                    isWebSocketConnecting
                                }
                            >
                                {isPlaying ? "一時停止" : "再生"}
                            </Button>
                            <Slider
                                value={[playbackPosition]}
                                max={lessonDurationSec}
                                disabled
                            />
                        </div>
                        <div className="flex justify-between gap-4">
                            <span>{formatTime(playbackPosition)}</span>
                            <span>{formatTime(lessonDurationSec)}</span>
                        </div>
                    </div>
                </>
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

            <Dialog open={screen === "login"}>
                <DialogContent
                    showCloseButton={false}
                    className="w-full max-w-md"
                >
                    <DialogHeader>
                        <DialogTitle>
                            {loginMode === "student"
                                ? "生徒ログイン"
                                : "教員ログイン"}
                        </DialogTitle>
                        <DialogDescription>
                            {loginMode === "student"
                                ? "学籍番号を入力して受講セッションを開始します。"
                                : "教員IDとパスワードを入力してください。"}
                        </DialogDescription>
                    </DialogHeader>

                    {loginMode === "student" ? (
                        <form
                            className="flex flex-col gap-4"
                            onSubmit={startStudentSession}
                        >
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="studentId">学籍番号</Label>
                                <Input
                                    id="studentId"
                                    placeholder="学籍番号を入力"
                                    value={studentId}
                                    disabled={screenState === "starting"}
                                    onChange={(event) =>
                                        setStudentId(event.target.value)
                                    }
                                />
                            </div>
                            <Button disabled={!canSubmitStudent} type="submit">
                                {screenState === "starting"
                                    ? "開始中..."
                                    : "ログイン"}
                            </Button>
                            <Button
                                type="button"
                                variant="link"
                                onClick={() => setLoginMode("teacher")}
                            >
                                教員ログインはこちら
                            </Button>
                        </form>
                    ) : (
                        <form
                            className="flex flex-col gap-4"
                            onSubmit={submitTeacherLogin}
                        >
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="teacherId">教員ID</Label>
                                <Input
                                    id="teacherId"
                                    value={teacherId}
                                    onChange={(event) =>
                                        setTeacherId(event.target.value)
                                    }
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="teacherPassword">
                                    パスワード
                                </Label>
                                <Input
                                    id="teacherPassword"
                                    type="password"
                                    value={teacherPassword}
                                    onChange={(event) =>
                                        setTeacherPassword(event.target.value)
                                    }
                                />
                            </div>
                            <Button disabled={!canSubmitTeacher} type="submit">
                                ログイン
                            </Button>
                            <Button
                                type="button"
                                variant="link"
                                onClick={() => setLoginMode("student")}
                            >
                                生徒ログインに戻る
                            </Button>
                        </form>
                    )}

                    {message && screen === "login" && (
                        <Alert variant={hasError ? "destructive" : "default"}>
                            <AlertTitle>
                                {hasError ? "確認してください" : "状態"}
                            </AlertTitle>
                            <AlertDescription>{message}</AlertDescription>
                        </Alert>
                    )}
                </DialogContent>
            </Dialog>

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
                            ref={(element) => {
                                cameraVideoRef.current = element;
                                attachStreamToCameraVideo();
                            }}
                            className="aspect-4/3 w-full object-cover"
                            muted
                            playsInline
                        />
                        <Progress value={calibrationProgress} />
                        <div className="flex justify-between gap-4">
                            <span>進捗</span>
                            <span>{Math.round(calibrationProgress)}%</span>
                        </div>
                        <Separator />
                        <div className="flex justify-between gap-4">
                            <span>sessionId</span>
                            <span>{sessionId ?? "未開始"}</span>
                        </div>
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

function formatTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
