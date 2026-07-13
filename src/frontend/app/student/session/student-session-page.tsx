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
import * as signalR from "@microsoft/signalr";

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
    | "ended"
    | "error";

type ServiceCheckState = "idle" | "checking" | "ready" | "error";
type AnalysisStreamState = "idle" | "connecting" | "connected" | "error";
type DrowsinessLevel = "normal" | "caution" | "warning" | "danger";
type AutoPauseState = "idle" | "paused" | "recoverable";
type AutoPauseReason = "drowsiness" | "face_not_detected";
type PlaybackEventType = "auto_pause" | "resume";

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

type CalibrationStatusEvent = {
    type: "calibration_status";
    sessionId: string;
    updatedAt: string;
    status: "calibrating" | "succeeded" | "failed";
    validFrames: number;
    totalFrames: number;
    targetFrames: number;
    earOpen: number | null;
    earThreshold: number | null;
};

type AnalysisEvent =
    | DrowsinessScoreEvent
    | TrackingStatusEvent
    | CalibrationStatusEvent;

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";
const frameIntervalMs = 200;
const framesPerIFrame = 5;
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
const playbackEventRequestTimeoutMs = 3000;
const maxWebSocketConnectAttempts = 5;
const webSocketBackoffBaseMs = 500;
const autoPauseRewindSec = 5;
const controlsInactivityTimeoutMs = 3000;

export default function StudentSessionPage() {
    const router = useRouter();
    const [studentId, setStudentId] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [screenState, setScreenState] = useState<StudentScreenState>("camera_permission_required");
    const [message, setMessage] = useState<string | null>(null);
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
    const [resultStreamState, setResultStreamState] =
        useState<AnalysisStreamState>("idle");
    const [latestScore, setLatestScore] =
        useState<DrowsinessScoreEvent | null>(null);
    const [latestTracking, setLatestTracking] =
        useState<TrackingStatusEvent | null>(null);
    const [calibrationStatus, setCalibrationStatus] =
        useState<CalibrationStatusEvent | null>(null);
    const [autoPauseState, setAutoPauseState] =
        useState<AutoPauseState>("idle");
    const [autoPauseReason, setAutoPauseReason] =
        useState<AutoPauseReason | null>(null);
    const [areControlsVisible, setAreControlsVisible] = useState(true);

    const lessonVideoRef = useRef<HTMLVideoElement | null>(null);
    const cameraCaptureVideoRef = useRef<HTMLVideoElement | null>(null);
    const calibrationPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
    const autoPausePreviewVideoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const resultConnectionRef = useRef<signalR.HubConnection | null>(null);
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
    const controlsInactivityTimeoutRef = useRef<ReturnType<
        typeof setTimeout
    > | null>(null);
    const webSocketConnectionIdRef = useRef(0);
    const activeSessionIdRef = useRef<string | null>(null);
    const sequenceNoRef = useRef(1);
    const baseIFrameSequenceNoRef = useRef(1);
    const sendingRef = useRef(false);
    const isPlayingRef = useRef(false);
    const isAnalysisActiveRef = useRef(false);
    const autoPauseStateRef = useRef<AutoPauseState>("idle");
    const autoPauseReasonRef = useRef<AutoPauseReason | null>(null);
    const autoPauseEventSentRef = useRef(false);
    const pendingResumePlaybackEventRef = useRef(false);
    const pendingPlaybackAfterSocketOpenRef = useRef(false);
    const pendingAnalysisAfterSocketOpenRef = useRef(false);
    const lessonVideoFileName = getLessonVideoFileName(lessonVideoUrl);

    useEffect(() => {
        return () => {
            stopFrameSending();
            stopPlaybackTimer();
            stopCalibrationTimer();
            clearWebSocketRetryTimer();
            socketRef.current?.close();
            void resultConnectionRef.current?.stop();
            streamRef.current?.getTracks().forEach((track) => track.stop());
        };
    }, []);

    useEffect(() => {
        function clearControlsInactivityTimer() {
            if (controlsInactivityTimeoutRef.current) {
                clearTimeout(controlsInactivityTimeoutRef.current);
                controlsInactivityTimeoutRef.current = null;
            }
        }

        function scheduleControlsAutoHide() {
            clearControlsInactivityTimer();
            controlsInactivityTimeoutRef.current = setTimeout(() => {
                setAreControlsVisible(false);
            }, controlsInactivityTimeoutMs);
        }

        function handleUserActivity() {
            setAreControlsVisible(true);
            scheduleControlsAutoHide();
        }

        handleUserActivity();
        window.addEventListener("pointermove", handleUserActivity);
        window.addEventListener("pointerdown", handleUserActivity);
        window.addEventListener("keydown", handleUserActivity);
        window.addEventListener("touchstart", handleUserActivity);

        return () => {
            clearControlsInactivityTimer();
            window.removeEventListener("pointermove", handleUserActivity);
            window.removeEventListener("pointerdown", handleUserActivity);
            window.removeEventListener("keydown", handleUserActivity);
            window.removeEventListener("touchstart", handleUserActivity);
        };
    }, []);

    const setCameraCaptureVideoElement = useCallback(
        (element: HTMLVideoElement | null) => {
            cameraCaptureVideoRef.current = element;

            if (element && streamRef.current) {
                attachStreamToVideo(element, streamRef.current);
            }
        },
        [],
    );

    const setCalibrationPreviewVideoElement = useCallback(
        (element: HTMLVideoElement | null) => {
            calibrationPreviewVideoRef.current = element;

            if (element && streamRef.current) {
                attachStreamToVideo(element, streamRef.current);
            }
        },
        [],
    );

    const setAutoPausePreviewVideoElement = useCallback(
        (element: HTMLVideoElement | null) => {
            autoPausePreviewVideoRef.current = element;

            if (element && streamRef.current) {
                attachStreamToVideo(element, streamRef.current);
            }
        },
        [],
    );

    useEffect(() => {
        if (isCalibrationOpen) {
            attachStreamToCameraVideos();
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
                connectResultStream(storedSession.sessionId);
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
        attachStreamToCameraVideos();
    }

    function attachStreamToCameraVideos() {
        const stream = streamRef.current;

        if (!stream) {
            return;
        }

        const captureVideo = cameraCaptureVideoRef.current;
        const calibrationPreviewVideo = calibrationPreviewVideoRef.current;
        const autoPausePreviewVideo = autoPausePreviewVideoRef.current;

        if (captureVideo) {
            attachStreamToVideo(captureVideo, stream);
        }

        if (calibrationPreviewVideo) {
            attachStreamToVideo(calibrationPreviewVideo, stream);
        }

        if (autoPausePreviewVideo) {
            attachStreamToVideo(autoPausePreviewVideo, stream);
        }
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
        connectResultStream(activeSessionId);
        setIsCalibrationOpen(true);
        setScreenState("calibration_ready");
        connectFrameSocketWithRetry(activeSessionId, stream, false);
    }

    function connectResultStream(activeSessionId: string) {
        void resultConnectionRef.current?.stop();
        setResultStreamState("connecting");

        const connection = new signalR.HubConnectionBuilder()
            .withUrl(buildAnalysisEventsHubUrl())
            .withAutomaticReconnect()
            .build();
        resultConnectionRef.current = connection;

        connection.on("ReceiveAnalysisEvent", (payload: unknown) => {
            const analysisEvent = parseAnalysisEvent(payload);
            if (!analysisEvent || analysisEvent.sessionId !== activeSessionId) {
                return;
            }

            handleAnalysisEvent(analysisEvent);
        });

        connection.onreconnecting(() => {
            setResultStreamState("connecting");
        });

        connection.onreconnected(() => {
            void connection
                .invoke("JoinSession", activeSessionId)
                .then(() => setResultStreamState("connected"))
                .catch(() => setResultStreamState("error"));
        });

        connection.onclose(() => {
            setResultStreamState("error");
            if (screenState === "calibrating" || screenState === "streaming") {
                setMessage(
                    "解析結果イベントストリームでエラーが発生しました。Backend の起動状態を確認してください。",
                );
            }
        });

        connection
            .start()
            .then(() => connection.invoke("JoinSession", activeSessionId))
            .then(() => {
                setResultStreamState("connected");
            })
            .catch(() => {
                setResultStreamState("error");
                setMessage(
                    "解析結果イベントストリームへの接続に失敗しました。Backend の起動状態を確認してください。",
                );
            });
    }

    function handleAnalysisEvent(analysisEvent: AnalysisEvent) {
        if (analysisEvent.type === "calibration_status") {
            handleCalibrationStatus(analysisEvent);
            return;
        }

        if (analysisEvent.type === "drowsiness_score") {
            handleDrowsinessScore(analysisEvent);
            return;
        }

        handleTrackingStatus(analysisEvent);
    }

    function handleTrackingStatus(event: TrackingStatusEvent) {
        setLatestTracking(event);

        if (event.status !== "face_not_detected") {
            return;
        }

        if (isPlayingRef.current) {
            autoPausePlayback("face_not_detected");
            return;
        }

        if (autoPauseStateRef.current === "recoverable") {
            showAutoPauseBlockedMessage("face_not_detected");
        }
    }

    function handleCalibrationStatus(event: CalibrationStatusEvent) {
        setCalibrationStatus(event);
        setCalibrationProgress(
            event.targetFrames > 0
                ? Math.min((event.totalFrames / event.targetFrames) * 100, 100)
                : 0,
        );

        if (event.status === "succeeded") {
            completeCalibration();
            return;
        }

        if (event.status === "failed") {
            stopFrameSending();
            setScreenState("calibration_ready");
            setMessage(
                "キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。",
            );
        }
    }

    function handleDrowsinessScore(event: DrowsinessScoreEvent) {
        setLatestScore(event);
        setLatestTracking(null);

        if (shouldAutoPause(event)) {
            if (isPlayingRef.current) {
                autoPausePlayback("drowsiness");
                return;
            }

            if (autoPauseStateRef.current === "recoverable") {
                showAutoPauseBlockedMessage("drowsiness");
            }
            return;
        }

        if (autoPauseStateRef.current === "paused" && event.level === "normal") {
            const pauseReason = autoPauseReasonRef.current;
            autoPauseStateRef.current = "recoverable";
            setAutoPauseState("recoverable");
            setLatestTracking(null);
            setMessage(
                pauseReason === "face_not_detected"
                    ? "あなたのお顔がよくみえます！再生ボタンを押すと動画が再開します。"
                    : "起きていることが確認できました。再生ボタンを押すと再開します。",
            );
        }
    }

    function autoPausePlayback(reason: AutoPauseReason) {
        const lessonVideo = lessonVideoRef.current;
        const pauseVideoTimeSec = lessonVideo
            ? getCurrentVideoTime(lessonVideo)
            : playbackPosition;

        isPlayingRef.current = false;
        setIsPlaying(false);
        setScreenState("paused");

        if (lessonVideo) {
            lessonVideo.pause();
            setPlaybackPosition(Math.floor(rewindLessonVideo(lessonVideo)));
        }

        stopPlaybackTimer();
        showAutoPauseBlockedMessage(reason);

        if (!autoPauseEventSentRef.current) {
            autoPauseEventSentRef.current = true;
            void sendPlaybackEvent(
                activeSessionIdRef.current,
                "auto_pause",
                pauseVideoTimeSec,
            );
        }
    }

    function rewindLessonVideo(video: HTMLVideoElement) {
        const currentTime = Number.isFinite(video.currentTime)
            ? video.currentTime
            : 0;
        const rewoundTime = Math.max(0, currentTime - autoPauseRewindSec);
        video.currentTime = rewoundTime;
        return rewoundTime;
    }

    function showAutoPauseBlockedMessage(reason: AutoPauseReason) {
        autoPauseStateRef.current = "paused";
        autoPauseReasonRef.current = reason;
        setAutoPauseState("paused");
        setAutoPauseReason(reason);
        setMessage(
            reason === "face_not_detected"
                ? "顔が検出できません。カメラの状態を確認し、顔と目がしっかり映っているか確認してください！"
                : "眠っていますか？目が閉じているため、動画を一時停止しています。",
        );
    }

    function startCalibration() {
        const activeSessionId = activeSessionIdRef.current;
        const stream = streamRef.current;

        if (!activeSessionId || !stream) {
            setScreenState("error");
            setMessage(
                "受講セッションまたはカメラ映像が初期化されていません。",
            );
            return;
        }

        if (resultStreamState !== "connected") {
            setMessage(
                "解析結果イベントストリームへの接続完了後にキャリブレーションを開始してください。",
            );
            return;
        }

        stopCalibrationTimer();
        setCalibrationProgress(0);
        setCalibrationStatus(null);
        setLatestTracking(null);
        setMessage(null);
        setScreenState("calibrating");

        if (socketRef.current?.readyState === WebSocket.OPEN) {
            startFrameSending(activeSessionId, stream);
            return;
        }

        pendingAnalysisAfterSocketOpenRef.current = true;
        connectFrameSocketWithRetry(activeSessionId, stream, false);
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
        if (screenState === "ended") {
            return;
        }

        if (autoPauseStateRef.current === "paused") {
            setMessage(
                autoPauseReasonRef.current === "face_not_detected"
                    ? "顔が検出できるまで動画を再開できません。"
                    : "眠気レベルが normal に戻るまで動画を再開できません。",
            );
            return;
        }

        const shouldSendResumeEvent = autoPauseStateRef.current === "recoverable";

        if (shouldSendResumeEvent) {
            autoPauseStateRef.current = "idle";
            autoPauseReasonRef.current = null;
            setAutoPauseState("idle");
            setAutoPauseReason(null);
            setMessage(null);
        }

        const activeSessionId = activeSessionIdRef.current;
        const stream = streamRef.current;

        if (!activeSessionId || !stream) {
            setScreenState("error");
            setMessage(
                "受講セッションまたはカメラ映像が初期化されていません。",
            );
            return;
        }

        pendingResumePlaybackEventRef.current =
            pendingResumePlaybackEventRef.current || shouldSendResumeEvent;

        if (socketRef.current?.readyState === WebSocket.OPEN) {
            beginPlaybackAfterSocketOpen(activeSessionId, stream);
            return;
        }

        connectFrameSocketWithRetry(activeSessionId, stream, true);
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
        ensureFrameSending(activeSessionId, stream);

        if (pendingResumePlaybackEventRef.current) {
            pendingResumePlaybackEventRef.current = false;
            autoPauseEventSentRef.current = false;
            void sendPlaybackEvent(
                activeSessionId,
                "resume",
                lessonVideoRef.current
                    ? getCurrentVideoTime(lessonVideoRef.current)
                    : playbackPosition,
            );
        }
    }

    function pausePlayback() {
        webSocketConnectionIdRef.current += 1;
        pendingPlaybackAfterSocketOpenRef.current = false;
        pendingAnalysisAfterSocketOpenRef.current = false;
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

                const hasEnded = video ? video.ended : nextPosition >= duration;

                if (hasEnded) {
                    stopPlaybackTimer();
                    stopFrameSending();
                    isPlayingRef.current = false;
                    setIsPlaying(false);
                    video?.pause();
                    setMessage("おつかれさまでした。動画教材の受講が完了しました。");
                    setScreenState("ended");
                    return duration;
                }
                return Math.min(nextPosition, duration);
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
        setMessage("おつかれさまでした。動画教材の受講が完了しました。");
        setScreenState("ended");
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
            if (pendingAnalysisAfterSocketOpenRef.current) {
                pendingAnalysisAfterSocketOpenRef.current = false;
                startFrameSending(activeSessionId, stream);
            }
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

            if (pendingAnalysisAfterSocketOpenRef.current) {
                pendingAnalysisAfterSocketOpenRef.current = false;
                startFrameSending(activeSessionId, stream);
            }

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
            pendingAnalysisAfterSocketOpenRef.current = false;
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

    function ensureFrameSending(activeSessionId: string, stream: MediaStream) {
        isAnalysisActiveRef.current = true;
        if (frameIntervalRef.current) {
            return;
        }

        startFrameSending(activeSessionId, stream);
    }

    function startFrameSending(activeSessionId: string, stream: MediaStream) {
        stopFrameSending();
        isAnalysisActiveRef.current = true;

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

        frameIntervalRef.current = setInterval(() => {
            void captureAndSendFrame(activeSessionId, canvas);
        }, frameIntervalMs);
    }

    function stopFrameSending() {
        isAnalysisActiveRef.current = false;
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
        const video = cameraCaptureVideoRef.current;

        if (
            sendingRef.current ||
            !isAnalysisActiveRef.current ||
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
        } catch (error) {
            setScreenState("error");
            setMessage(
                error instanceof Error
                    ? error.message
                    : "フレーム送信中にエラーが発生しました。",
            );
            stopFrameSending();
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

    const isCameraSending =
        isPlaying || screenState === "calibrating" || autoPauseState !== "idle";
    const controlsVisibilityClass = areControlsVisible
        ? "opacity-100"
        : "pointer-events-none opacity-0";

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
            <video
                ref={setCameraCaptureVideoElement}
                className="pointer-events-none absolute h-px w-px opacity-0"
                muted
                playsInline
            />

            <header
                className={`absolute top-0 right-0 left-0 z-10 flex items-center justify-between gap-4 bg-black/60 px-6 py-3 text-white transition-opacity duration-150 ${controlsVisibilityClass}`}
            >
                <span className="min-w-0 truncate font-medium">
                    {lessonVideoFileName}
                </span>
                <div className="group/badges flex shrink-0 gap-2">
                    {studentId && <Badge variant="secondary">{studentId}</Badge>}
                    <Badge>{isCameraSending ? "カメラ送信中" : "カメラ待機中"}</Badge>
                    {latestScore && (
                        <Badge
                            className="hidden group-hover/badges:inline-flex group-focus-within/badges:inline-flex"
                            variant={
                                shouldAutoPause(latestScore)
                                    ? "destructive"
                                    : "secondary"
                            }
                        >
                            score {latestScore.score.toFixed(2)} / {latestScore.level}
                        </Badge>
                    )}
                </div>
            </header>

            <footer
                className={`absolute right-0 bottom-0 left-0 z-10 flex flex-col gap-3 bg-black/60 px-6 py-4 text-white transition-opacity duration-150 ${controlsVisibilityClass}`}
            >
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
                            !isCalibrationDone ||
                            autoPauseState === "paused" ||
                            screenState === "ended" ||
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
            </footer>

            {message && (
                <div className="absolute top-20 left-1/2 w-full max-w-md -translate-x-1/2 px-4">
                    <Alert
                        variant={
                            screenState === "error" ? "destructive" : "default"
                        }
                    >
                        <AlertTitle>
                            {screenState === "ended"
                                ? "受講が完了しました"
                                : screenState === "error"
                                  ? "確認してください"
                                  : autoPauseState === "paused" &&
                                    autoPauseReason === "face_not_detected"
                                  ? "そこにいる？"
                                  : autoPauseState === "paused"
                                    ? "おきて！"
                                    : autoPauseState === "recoverable" &&
                                        autoPauseReason === "face_not_detected"
                                      ? "おかえり！"
                                      : autoPauseState === "recoverable"
                                        ? "おはよう！"
                                        : "状態"}
                        </AlertTitle>
                        <AlertDescription className="flex flex-col gap-3">
                            <span>{message}</span>
                            {autoPauseState === "paused" &&
                                autoPauseReason === "drowsiness" &&
                                latestScore && (
                                    <span>
                                        {latestScore.score.toFixed(2)} / 1.0
                                    </span>
                                )}
                            {autoPauseState === "paused" &&
                                autoPauseReason === "face_not_detected" && (
                                    <video
                                        ref={setAutoPausePreviewVideoElement}
                                        className="aspect-4/3 w-full object-cover"
                                        muted
                                        playsInline
                                    />
                                )}
                            {(screenState === "error" || screenState === "ended") && (
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

            {latestTracking && !message && autoPauseState === "idle" && (
                <div className="absolute top-20 left-1/2 w-full max-w-md -translate-x-1/2 px-4">
                    <Alert>
                        <AlertTitle>顔検出</AlertTitle>
                        <AlertDescription>
                            顔が検出できません。カメラ位置を調整してください。
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
                            ref={setCalibrationPreviewVideoElement}
                            className="aspect-4/3 w-full object-cover"
                            muted
                            playsInline
                        />
                        <div className="grid gap-2 text-sm md:grid-cols-2">
                            <span className="text-muted-foreground">
                                WebSocket: {isWebSocketConnected ? "接続済み" : "接続中"}
                            </span>
                            <span className="text-muted-foreground">
                                解析イベント: {resultStreamState}
                            </span>
                        </div>
                        {screenState === "calibrating" && (
                            <>
                                <Progress value={calibrationProgress} />
                                <div className="flex justify-between text-sm text-muted-foreground">
                                    <span>
                                        {calibrationStatus
                                            ? `${calibrationStatus.validFrames}/${calibrationStatus.totalFrames} frames`
                                            : "Worker 解析待ち"}
                                    </span>
                                    <span>{Math.round(calibrationProgress)}%</span>
                                </div>
                            </>
                        )}
                        {calibrationStatus?.status === "failed" && (
                            <Alert variant="destructive">
                                <AlertTitle>キャリブレーション失敗</AlertTitle>
                                <AlertDescription>
                                    顔が正面から映るようにカメラ位置を調整して、もう一度開始してください。
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            onClick={startCalibration}
                            disabled={
                                screenState === "calibrating" ||
                                resultStreamState !== "connected"
                            }
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

function getCurrentVideoTime(video: HTMLVideoElement) {
    return Number.isFinite(video.currentTime) ? video.currentTime : 0;
}

async function sendPlaybackEvent(
    sessionId: string | null,
    type: PlaybackEventType,
    videoTimeSec: number,
) {
    if (!sessionId) {
        console.warn("再生イベントを送信できませんでした。sessionId がありません。", {
            type,
            videoTimeSec,
        });
        return;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(
        () => abortController.abort(),
        playbackEventRequestTimeoutMs,
    );

    try {
        const response = await fetch(buildPlaybackEventsUrl(sessionId), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                type,
                occurredAt: new Date().toISOString(),
                videoTimeSec,
            }),
            signal: abortController.signal,
        });

        if (!response.ok) {
            console.warn("再生イベントの送信に失敗しました。", {
                type,
                videoTimeSec,
                status: response.status,
            });
        }
    } catch (error) {
        console.warn("再生イベントの送信に失敗しました。", {
            type,
            videoTimeSec,
            error,
        });
    } finally {
        clearTimeout(timeoutId);
    }
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

function buildAnalysisEventsHubUrl() {
    const url = new URL(apiBaseUrl);
    url.pathname = "/hubs/analysis-events";
    url.search = "";
    return url.toString();
}

function buildPlaybackEventsUrl(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.pathname = `/api/sessions/${sessionId}/playback-events`;
    url.search = "";
    return url.toString();
}

function parseAnalysisEvent(value: unknown): AnalysisEvent | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const parsed = value as Partial<AnalysisEvent>;
    if (
        parsed.type === "drowsiness_score" &&
        typeof parsed.sessionId === "string"
    ) {
        return parsed as DrowsinessScoreEvent;
    }
    if (
        parsed.type === "tracking_status" &&
        typeof parsed.sessionId === "string"
    ) {
        return parsed as TrackingStatusEvent;
    }
    if (
        parsed.type === "calibration_status" &&
        typeof parsed.sessionId === "string"
    ) {
        return parsed as CalibrationStatusEvent;
    }
    return null;
}

function shouldAutoPause(score: DrowsinessScoreEvent) {
    return score.shouldPause || score.level === "danger" || score.score >= 0.75;
}

function getLessonVideoFileName(videoUrl: string) {
    try {
        const pathname = new URL(videoUrl).pathname;
        const fileName = pathname.split("/").filter(Boolean).at(-1);
        return fileName ? decodeURIComponent(fileName) : "動画教材";
    } catch {
        const fileName = videoUrl.split("/").filter(Boolean).at(-1);
        return fileName || "動画教材";
    }
}

function formatTime(seconds: number) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
