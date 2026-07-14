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
import { apiFetch, getCurrentPrincipal } from "@/lib/api-client";
import {
    markStoredSessionCalibrated,
    readStoredStudentSession,
    studentSessionStorageKey,
    updateStoredSessionPlaybackPosition,
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
type PlaybackEventType =
    | "manual_pause"
    | "auto_pause"
    | "resume"
    | "completed";

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

type PersistedCalibration = Extract<
    CalibrationStatusEvent,
    { status: "succeeded" }
>;

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";
const frameIntervalMs = 200;
const calibrationDurationMs = 5_000;
const calibrationProgressIntervalMs = 100;
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
    const [webSocketConnectAttempt, setWebSocketConnectAttempt] = useState(0);
    const [isWebSocketErrorOpen, setIsWebSocketErrorOpen] = useState(false);
    const [isResultStreamErrorOpen, setIsResultStreamErrorOpen] =
        useState(false);
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
    const frameCaptureGenerationRef = useRef(0);
    const sendingRef = useRef(false);
    const isPlayingRef = useRef(false);
    const isAnalysisActiveRef = useRef(false);
    const screenStateRef = useRef<StudentScreenState>(
        "camera_permission_required",
    );
    const resultStreamStateRef = useRef<AnalysisStreamState>("idle");
    const calibrationActiveRef = useRef(false);
    const isCalibrationDoneRef = useRef(false);
    const restoredPlaybackPositionRef = useRef<number | null>(null);
    const playbackPositionRef = useRef(0);
    const lessonCompletedRef = useRef(false);
    const webSocketRecoveryPlaybackRef = useRef(false);
    const autoPauseStateRef = useRef<AutoPauseState>("idle");
    const autoPauseReasonRef = useRef<AutoPauseReason | null>(null);
    const autoPauseEventSentRef = useRef(false);
    const pendingResumePlaybackEventRef = useRef(false);
    const pendingManualResumePlaybackEventRef = useRef(false);
    const pendingPlaybackAfterSocketOpenRef = useRef(false);
    const pendingAnalysisAfterSocketOpenRef = useRef(false);
    const pendingFrameMessagesRef = useRef(new Map<number, { payload: string; retries: number }>());
    const lessonVideoFileName = getLessonVideoFileName(lessonVideoUrl);

    useEffect(() => {
        screenStateRef.current = screenState;
    }, [screenState]);

    useEffect(() => {
        resultStreamStateRef.current = resultStreamState;
    }, [resultStreamState]);

    useEffect(() => {
        playbackPositionRef.current = playbackPosition;
    }, [playbackPosition]);

    useEffect(() => {
        const pendingFrameMessages = pendingFrameMessagesRef.current;
        return () => {
            webSocketConnectionIdRef.current += 1;
            stopFrameSending();
            stopPlaybackTimer();
            stopCalibrationTimer();
            clearWebSocketRetryTimer();
            socketRef.current?.close();
            pendingFrameMessages.clear();
            const resultConnection = resultConnectionRef.current;
            resultConnectionRef.current = null;
            void resultConnection?.stop();
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

            try {
                const { response, principal } = await getCurrentPrincipal();
                if (!isActive) return;

                const sessionDoesNotMatchPrincipal =
                    response.ok &&
                    (principal?.role !== "student_session" ||
                        (principal.studentSessionId ?? principal.principalId) !==
                            storedSession.sessionId);

                if (
                    response.status === 401 ||
                    response.status === 403 ||
                    sessionDoesNotMatchPrincipal
                ) {
                    sessionStorage.removeItem(studentSessionStorageKey);
                    router.replace("/student");
                    return;
                }

                if (!response.ok) {
                    setScreenState("error");
                    setMessage("認証状態を確認できませんでした。接続を確認して再試行してください。");
                    return;
                }
            } catch {
                setScreenState("error");
                setMessage("認証状態を確認できませんでした。接続を確認して再試行してください。");
                return;
            }

            let persistedCalibration: PersistedCalibration | null;
            try {
                persistedCalibration = await getPersistedCalibration(
                    storedSession.sessionId,
                );
                if (!isActive) return;
            } catch (error) {
                setScreenState("error");
                setMessage(
                    error instanceof Error
                        ? error.message
                        : "キャリブレーション状態を確認できませんでした。",
                );
                return;
            }

            restoredPlaybackPositionRef.current =
                storedSession.playbackPositionSec ?? null;
            playbackPositionRef.current = storedSession.playbackPositionSec ?? 0;
            setPlaybackPosition(storedSession.playbackPositionSec ?? 0);
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
                if (persistedCalibration) {
                    calibrationActiveRef.current = false;
                    isCalibrationDoneRef.current = true;
                    setCalibrationStatus(persistedCalibration);
                    setCalibrationProgress(100);
                    setIsCalibrationDone(true);
                    setIsCalibrationOpen(false);
                    setScreenState("ready");
                    markStoredSessionCalibrated(storedSession.sessionId);
                    connectFrameSocketWithRetry(
                        storedSession.sessionId,
                        stream,
                        false,
                    );
                } else {
                    setIsCalibrationOpen(true);
                    setScreenState("calibration_ready");
                    connectFrameSocketWithRetry(
                        storedSession.sessionId,
                        stream,
                        false,
                    );
                }
                connectResultStream(storedSession.sessionId);
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
        const previousConnection = resultConnectionRef.current;
        resultConnectionRef.current = null;
        void previousConnection?.stop();
        resultStreamStateRef.current = "connecting";
        setResultStreamState("connecting");

        const connection = new signalR.HubConnectionBuilder()
            .withUrl(buildAnalysisEventsHubUrl(), { withCredentials: true })
            .withAutomaticReconnect()
            .build();
        resultConnectionRef.current = connection;

        const isCurrentConnection = () =>
            resultConnectionRef.current === connection;

        connection.on("ReceiveAnalysisEvent", (payload: unknown) => {
            if (!isCurrentConnection()) {
                return;
            }

            const analysisEvent = parseAnalysisEvent(payload);
            if (!analysisEvent || analysisEvent.sessionId !== activeSessionId) {
                return;
            }

            handleAnalysisEvent(analysisEvent);
        });

        connection.onreconnecting(() => {
            if (!isCurrentConnection()) {
                return;
            }

            resultStreamStateRef.current = "connecting";
            setResultStreamState("connecting");
            pauseForResultStreamReconnect();
        });

        connection.onreconnected(() => {
            if (!isCurrentConnection()) {
                return;
            }

            void connection
                .invoke("JoinSession", activeSessionId)
                .then(() => {
                    if (!isCurrentConnection()) {
                        return;
                    }

                    resultStreamStateRef.current = "connected";
                    setResultStreamState("connected");
                    if (pendingAnalysisAfterSocketOpenRef.current) {
                        pendingAnalysisAfterSocketOpenRef.current = false;
                        const stream = streamRef.current;
                        if (stream && socketRef.current?.readyState === WebSocket.OPEN) {
                            startFrameSending(activeSessionId, stream);
                        }
                    }
                })
                .catch(() => {
                    if (!isCurrentConnection()) {
                        return;
                    }

                    handleResultStreamFailure(
                        "解析結果イベントストリームの再参加に失敗しました。Backend の起動状態を確認してください。",
                    );
                });
        });

        connection.onclose(() => {
            if (!isCurrentConnection()) {
                return;
            }

            handleResultStreamFailure(
                "解析結果イベントストリームでエラーが発生しました。Backend の起動状態を確認して再接続してください。",
            );
        });

        void connection
            .start()
            .then(() => connection.invoke("JoinSession", activeSessionId))
            .then(() => {
                if (!isCurrentConnection()) {
                    return;
                }

                resultStreamStateRef.current = "connected";
                setResultStreamState("connected");
            })
            .catch(() => {
                if (!isCurrentConnection()) {
                    return;
                }

                handleResultStreamFailure(
                    "解析結果イベントストリームへの接続に失敗しました。Backend の起動状態を確認して再接続してください。",
                );
            });
    }

    function handleResultStreamFailure(failureMessage: string) {
        const wasCalibrating =
            calibrationActiveRef.current ||
            screenStateRef.current === "calibrating";
        const wasPlaying = isPlayingRef.current;

        resultStreamStateRef.current = "error";
        setResultStreamState("error");
        webSocketRecoveryPlaybackRef.current = false;
        pendingPlaybackAfterSocketOpenRef.current = false;
        pendingAnalysisAfterSocketOpenRef.current = false;
        stopFrameSending();

        if (wasPlaying) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            lessonVideoRef.current?.pause();
            stopPlaybackTimer();
        }

        if (wasCalibrating && !isCalibrationDoneRef.current) {
            calibrationActiveRef.current = false;
            stopCalibrationTimer();
            setScreenState("calibration_ready");
        } else if (wasPlaying) {
            setScreenState("paused");
        }

        setMessage(failureMessage);
        setIsResultStreamErrorOpen(true);
    }

    function pauseForResultStreamReconnect() {
        const wasPlaying = isPlayingRef.current;
        webSocketRecoveryPlaybackRef.current = false;
        pendingPlaybackAfterSocketOpenRef.current = false;
        pendingAnalysisAfterSocketOpenRef.current = isAnalysisActiveRef.current;
        stopFrameSending();
        if (wasPlaying) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            lessonVideoRef.current?.pause();
            stopPlaybackTimer();
            setScreenState("paused");
        }
        setMessage("解析結果イベントストリームを再接続しています。再接続と再参加が完了するまで受講を停止します。");
    }

    function retryResultStream() {
        const activeSessionId = activeSessionIdRef.current;

        if (!activeSessionId) {
            setMessage("受講セッションが初期化されていません。");
            return;
        }

        setIsResultStreamErrorOpen(false);
        connectResultStream(activeSessionId);
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
            calibrationActiveRef.current = false;
            stopCalibrationTimer();
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
            const rewoundPosition = Math.floor(rewindLessonVideo(lessonVideo));
            playbackPositionRef.current = rewoundPosition;
            setPlaybackPosition(rewoundPosition);
            persistPlaybackPosition(rewoundPosition);
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
        calibrationActiveRef.current = true;
        startCalibrationTimer();

        if (socketRef.current?.readyState === WebSocket.OPEN) {
            startFrameSending(activeSessionId, stream);
            return;
        }

        pendingAnalysisAfterSocketOpenRef.current = true;
        connectFrameSocketWithRetry(activeSessionId, stream, false);
    }

    function completeCalibration() {
        if (isCalibrationDoneRef.current) {
            return;
        }

        calibrationActiveRef.current = false;
        isCalibrationDoneRef.current = true;
        stopCalibrationTimer();
        setCalibrationProgress(100);
        setIsCalibrationOpen(false);
        setIsCalibrationDone(true);
        setScreenState("ready");
        const activeSessionId = activeSessionIdRef.current;
        if (activeSessionId) {
            markStoredSessionCalibrated(activeSessionId);
        }
    }

    function startCalibrationTimer() {
        stopCalibrationTimer();
        const startedAt = Date.now();

        calibrationIntervalRef.current = setInterval(() => {
            const elapsedMs = Date.now() - startedAt;
            // 100% is reserved for a successful Worker notification. Reaching the
            // expected capture duration alone must not allow lesson playback.
            const progress = Math.min(
                (elapsedMs / calibrationDurationMs) * 100,
                99,
            );
            setCalibrationProgress(progress);

            if (elapsedMs >= calibrationDurationMs) {
                stopCalibrationTimer();
            }
        }, calibrationProgressIntervalMs);
    }

    function stopCalibrationTimer() {
        if (calibrationIntervalRef.current) {
            clearInterval(calibrationIntervalRef.current);
            calibrationIntervalRef.current = null;
        }
    }

    function startPlayback() {
        if (screenStateRef.current === "ended") {
            return;
        }

        if (!isCalibrationDoneRef.current) {
            setMessage(
                "キャリブレーション成功後に動画教材を再生できます。",
            );
            return;
        }

        if (resultStreamStateRef.current !== "connected") {
            setMessage(
                "解析結果イベントストリームの接続完了後に動画を再生できます。",
            );
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
        if (resultStreamStateRef.current !== "connected") {
            pendingPlaybackAfterSocketOpenRef.current = false;
            webSocketRecoveryPlaybackRef.current = true;
            isPlayingRef.current = false;
            setIsPlaying(false);
            lessonVideoRef.current?.pause();
            stopPlaybackTimer();
            setScreenState("paused");
            setMessage(
                "解析結果イベントストリームが接続されるまで動画を再生できません。",
            );
            return;
        }

        webSocketRecoveryPlaybackRef.current = false;
        isPlayingRef.current = true;
        setIsPlaying(true);
        setScreenState("streaming");
        setMessage(null);
        if (lessonVideoRef.current) {
            restoreLessonPlaybackPosition(lessonVideoRef.current);
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
        if (!isPlayingRef.current) {
            return;
        }

        const videoTimeSec = lessonVideoRef.current
            ? getCurrentVideoTime(lessonVideoRef.current)
            : playbackPositionRef.current;

        webSocketConnectionIdRef.current += 1;
        webSocketRecoveryPlaybackRef.current = false;
        pendingPlaybackAfterSocketOpenRef.current = false;
        pendingAnalysisAfterSocketOpenRef.current = false;
        clearWebSocketRetryTimer();
        setIsWebSocketConnecting(false);
        isPlayingRef.current = false;
        setIsPlaying(false);
        setScreenState("paused");
        lessonVideoRef.current?.pause();
        persistPlaybackPosition(videoTimeSec);
        stopPlaybackTimer();
        stopFrameSending();
        pendingManualResumePlaybackEventRef.current = true;
        void sendPlaybackEvent(
            activeSessionIdRef.current,
            "manual_pause",
            videoTimeSec,
        );
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
            const video = lessonVideoRef.current;
            const duration = getLessonDuration(video, lessonDurationSec);
            const nextPosition = video
                ? Math.floor(getCurrentVideoTime(video))
                : playbackPositionRef.current + 1;
            const finalPosition = Math.min(nextPosition, duration);

            const hasEnded = video ? video.ended : nextPosition >= duration;
            if (hasEnded) {
                completeLesson(finalPosition);
                return;
            }

            playbackPositionRef.current = finalPosition;
            setPlaybackPosition(finalPosition);
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
        restoreLessonPlaybackPosition(event.currentTarget);
    }

    function handleLessonTimeUpdate(event: SyntheticEvent<HTMLVideoElement>) {
        const position = Math.floor(getCurrentVideoTime(event.currentTarget));
        playbackPositionRef.current = position;
        setPlaybackPosition(position);
        persistPlaybackPosition(position);
    }

    function handleLessonPlaying(event: SyntheticEvent<HTMLVideoElement>) {
        if (!pendingManualResumePlaybackEventRef.current) {
            return;
        }

        pendingManualResumePlaybackEventRef.current = false;
        void sendPlaybackEvent(
            activeSessionIdRef.current,
            "resume",
            getCurrentVideoTime(event.currentTarget),
        );
    }

    function handleLessonEnded() {
        const video = lessonVideoRef.current;
        completeLesson(
            video ? getCurrentVideoTime(video) : lessonDurationSec,
        );
    }

    function completeLesson(finalPosition: number) {
        if (lessonCompletedRef.current) {
            return;
        }

        lessonCompletedRef.current = true;
        const completedPosition = Math.max(0, Math.floor(finalPosition));
        pendingResumePlaybackEventRef.current = false;
        pendingManualResumePlaybackEventRef.current = false;
        webSocketRecoveryPlaybackRef.current = false;
        pendingPlaybackAfterSocketOpenRef.current = false;
        pendingAnalysisAfterSocketOpenRef.current = false;
        isPlayingRef.current = false;
        setIsPlaying(false);
        lessonVideoRef.current?.pause();
        stopPlaybackTimer();
        stopFrameSending();
        playbackPositionRef.current = completedPosition;
        setPlaybackPosition(completedPosition);
        persistPlaybackPosition(completedPosition);
        setMessage("おつかれさまでした。動画教材の受講が完了しました。");
        setScreenState("ended");
        void sendPlaybackEvent(
            activeSessionIdRef.current,
            "completed",
            completedPosition,
        );
    }

    function restoreLessonPlaybackPosition(video: HTMLVideoElement) {
        const restoredPosition = restoredPlaybackPositionRef.current;
        if (restoredPosition === null) {
            return;
        }

        const duration = Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : null;
        const position = duration === null
            ? restoredPosition
            : Math.min(restoredPosition, duration);
        video.currentTime = position;
        playbackPositionRef.current = Math.floor(position);
        setPlaybackPosition(Math.floor(position));
        restoredPlaybackPositionRef.current = null;
    }

    function persistPlaybackPosition(position: number) {
        const activeSessionId = activeSessionIdRef.current;
        if (activeSessionId) {
            updateStoredSessionPlaybackPosition(activeSessionId, position);
        }
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
        pendingPlaybackAfterSocketOpenRef.current =
            startPlaybackOnOpen || pendingPlaybackAfterSocketOpenRef.current;
        if (startPlaybackOnOpen) {
            webSocketRecoveryPlaybackRef.current = true;
        }

        if (socketRef.current?.readyState === WebSocket.OPEN) {
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
        stopFrameSending();
        setIsWebSocketConnecting(true);
        setWebSocketConnectAttempt(attempt);
        if (showConnectingState) {
            setScreenState("ws_connecting");
        }

        const wsUrl = buildFrameWebSocketUrl(activeSessionId);
        const socket = new WebSocket(wsUrl);
        socketRef.current = socket;
        let hasOpened = false;
        let nextRetryAttempt = attempt;

            socket.addEventListener("open", () => {
            if (
                connectionId !== webSocketConnectionIdRef.current ||
                socketRef.current !== socket
            ) {
                socket.close();
                return;
            }

            hasOpened = true;
            nextRetryAttempt = 1;
            setIsWebSocketConnecting(false);
            setWebSocketConnectAttempt(0);
            pendingFrameMessagesRef.current.clear();

            if (pendingAnalysisAfterSocketOpenRef.current) {
                pendingAnalysisAfterSocketOpenRef.current = false;
                if (calibrationActiveRef.current) {
                    setScreenState("calibrating");
                }
                startFrameSending(activeSessionId, stream);
            }

            if (pendingPlaybackAfterSocketOpenRef.current) {
                pendingPlaybackAfterSocketOpenRef.current = false;
                beginPlaybackAfterSocketOpen(activeSessionId, stream);
            }
        });

        socket.addEventListener("close", () => {
            if (
                connectionId !== webSocketConnectionIdRef.current ||
                socketRef.current !== socket
            ) {
                return;
            }

            if (hasOpened) {
                handleUnexpectedFrameSocketClose();
            }
            stopFrameSending();

            scheduleFrameSocketRetry(
                activeSessionId,
                stream,
                hasOpened ? nextRetryAttempt : attempt,
                connectionId,
                showConnectingState || hasOpened,
            );
        });

        socket.addEventListener("error", () => {
            if (!hasOpened) {
                socket.close();
            }
        });

        socket.addEventListener("message", (event) => {
            if (socketRef.current !== socket || typeof event.data !== "string") return;
            try {
                const message = JSON.parse(event.data) as { type?: unknown; sequenceNo?: unknown; retryable?: unknown };
                if (typeof message.sequenceNo !== "number") return;
                if (message.type === "frame_ack") {
                    pendingFrameMessagesRef.current.delete(message.sequenceNo);
                    return;
                }
                if (message.type !== "frame_nack") return;
                const pending = pendingFrameMessagesRef.current.get(message.sequenceNo);
                if (!pending || message.retryable !== true || socket.readyState !== WebSocket.OPEN) return;
                if (pending.retries >= 3) {
                    pendingFrameMessagesRef.current.delete(message.sequenceNo);
                    setMessage("フレームの再送に失敗しました。接続を確認して再試行してください。");
                    return;
                }
                pending.retries += 1;
                socket.send(pending.payload);
            } catch {
                // Non-protocol server messages do not affect frame sending.
            }
        });
    }

    function handleUnexpectedFrameSocketClose() {
        const wasPlaying = isPlayingRef.current;
        const wasAnalyzing = isAnalysisActiveRef.current;
        const wasCalibrating =
            calibrationActiveRef.current ||
            screenStateRef.current === "calibrating";

        webSocketRecoveryPlaybackRef.current = wasPlaying;
        pendingPlaybackAfterSocketOpenRef.current = wasPlaying;
        pendingAnalysisAfterSocketOpenRef.current = wasAnalyzing;

        if (wasPlaying) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            lessonVideoRef.current?.pause();
            stopPlaybackTimer();
            setScreenState("ws_connecting");
        } else if (wasCalibrating) {
            setScreenState("ws_connecting");
        }

        setMessage(
            "WebSocketが切断されました。動画と解析を停止して再接続しています。",
        );
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
            setWebSocketConnectAttempt(0);
            isPlayingRef.current = false;
            setIsPlaying(false);
            lessonVideoRef.current?.pause();
            stopPlaybackTimer();
            stopFrameSending();
            pendingPlaybackAfterSocketOpenRef.current = false;
            pendingAnalysisAfterSocketOpenRef.current = false;
            const wasCalibrating =
                calibrationActiveRef.current ||
                screenStateRef.current === "calibrating" ||
                screenStateRef.current === "ws_connecting" &&
                    !isCalibrationDoneRef.current;
            calibrationActiveRef.current = false;
            if (wasCalibrating) {
                stopCalibrationTimer();
            }
            setScreenState(wasCalibrating ? "calibration_ready" : "error");
            setMessage(
                "WebSocket 接続に失敗しました。ネットワークまたはバックエンドの起動状態を確認してください。",
            );
            setIsWebSocketErrorOpen(true);
            return;
        }

        const delayMs = webSocketBackoffBaseMs * 2 ** (attempt - 1);
        webSocketRetryTimeoutRef.current = setTimeout(() => {
            webSocketRetryTimeoutRef.current = null;
            attemptFrameSocketConnection(
                activeSessionId,
                stream,
                attempt + 1,
                connectionId,
                showConnectingState,
            );
        }, delayMs);
    }

    function retryFrameSocketConnection() {
        const activeSessionId = activeSessionIdRef.current;
        const stream = streamRef.current;

        if (!activeSessionId || !stream) {
            setMessage("受講セッションまたはカメラ映像が初期化されていません。");
            return;
        }

        setIsWebSocketErrorOpen(false);
        if (!isCalibrationDoneRef.current) {
            if (calibrationStatus?.status === "failed") {
                startCalibration();
                return;
            }

            setScreenState("calibration_ready");
            connectFrameSocketWithRetry(activeSessionId, stream, false);
            return;
        }

        const shouldResumePlayback =
            webSocketRecoveryPlaybackRef.current &&
            autoPauseStateRef.current === "idle";
        pendingAnalysisAfterSocketOpenRef.current =
            autoPauseStateRef.current !== "idle";
        connectFrameSocketWithRetry(
            activeSessionId,
            stream,
            shouldResumePlayback,
        );
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

        const captureGeneration = frameCaptureGenerationRef.current;

        frameIntervalRef.current = setInterval(() => {
            void captureAndSendFrame(activeSessionId, canvas, captureGeneration);
        }, frameIntervalMs);
    }

    function stopFrameSending() {
        isAnalysisActiveRef.current = false;
        frameCaptureGenerationRef.current += 1;
        if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
        }
    }

    async function captureAndSendFrame(
        activeSessionId: string,
        canvas: HTMLCanvasElement,
        captureGeneration: number,
    ) {
        const socket = socketRef.current;
        const video = cameraCaptureVideoRef.current;

        if (
            captureGeneration !== frameCaptureGenerationRef.current ||
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
            const lessonVideo = lessonVideoRef.current;
            const videoTimeSec = lessonVideo ? getCurrentVideoTime(lessonVideo) : playbackPositionRef.current;
            const payloadBase64 = await canvasToBase64(canvas);
            if (
                captureGeneration !== frameCaptureGenerationRef.current ||
                !isAnalysisActiveRef.current ||
                socketRef.current !== socket ||
                socket.readyState !== WebSocket.OPEN
            ) {
                return;
            }

            const sequenceNo = sequenceNoRef.current;
            const serializedFrame = JSON.stringify({
                sessionId: activeSessionId,
                sequenceNo,
                capturedAt: new Date().toISOString(),
                videoTimeSec,
                codec: "image/jpeg",
                payloadBase64,
            });
            socket.send(serializedFrame);
            pendingFrameMessagesRef.current.set(sequenceNo, { payload: serializedFrame, retries: 0 });
            if (pendingFrameMessagesRef.current.size > 50) {
                const oldestSequenceNo = pendingFrameMessagesRef.current.keys().next().value;
                if (typeof oldestSequenceNo === "number") pendingFrameMessagesRef.current.delete(oldestSequenceNo);
            }

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
    const canStartLessonFromCenter =
        screenState === "ready" &&
        isCalibrationDone &&
        !isCalibrationOpen &&
        !isWebSocketConnecting &&
        resultStreamState === "connected" &&
        autoPauseState === "idle";
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
                onTimeUpdate={handleLessonTimeUpdate}
                onPlaying={handleLessonPlaying}
                onEnded={handleLessonEnded}
            />
            <video
                ref={setCameraCaptureVideoElement}
                className="pointer-events-none absolute h-px w-px opacity-0"
                muted
                playsInline
            />

            {canStartLessonFromCenter && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                    <Button
                        type="button"
                        size="lg"
                        className="pointer-events-auto"
                        aria-label="受講を開始"
                        onClick={startPlayback}
                    >
                        <PlayIcon aria-hidden="true" />
                        再生開始
                    </Button>
                </div>
            )}

            <header
                className={`absolute top-0 right-0 left-0 z-10 flex items-center justify-between gap-4 bg-black/60 px-6 py-3 text-white transition-opacity duration-150 ${controlsVisibilityClass}`}
            >
                <span className="min-w-0 truncate font-medium">
                    {lessonVideoFileName}
                </span>
                <div className="group/badges flex shrink-0 gap-2">
                    <Badge variant="secondary">受講者</Badge>
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
                            resultStreamState !== "connected" ||
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
                                retryFrameSocketConnection();
                            }}
                        >
                            再試行
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={isResultStreamErrorOpen}
                onOpenChange={setIsResultStreamErrorOpen}
            >
                <DialogContent className="w-full max-w-md">
                    <DialogHeader>
                        <DialogTitle>解析イベント接続エラー</DialogTitle>
                        <DialogDescription>
                            SignalRの接続またはセッション購読に失敗しました。動画と解析は停止しています。Backendの起動状態を確認して再接続してください。
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsResultStreamErrorOpen(false)}
                        >
                            閉じる
                        </Button>
                        <Button onClick={retryResultStream}>再接続</Button>
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
                        {screenState === "calibrating" && (
                            <>
                                <Progress value={calibrationProgress} />
                                <div className="flex justify-end text-sm text-muted-foreground">
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
                                isWebSocketConnecting ||
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
        const response = await apiFetch(buildPlaybackEventsPath(sessionId), {
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

        if (response.status === 401) {
            sessionStorage.removeItem(studentSessionStorageKey);
            window.location.assign("/student");
            return;
        }

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
    url.pathname = "/health/ready";
    url.search = "";
    return url.toString();
}

function buildAnalysisEventsHubUrl() {
    const url = new URL(apiBaseUrl);
    url.pathname = "/hubs/analysis-events";
    url.search = "";
    return url.toString();
}

function buildPlaybackEventsPath(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.pathname = `/api/sessions/${sessionId}/playback-events`;
    url.search = "";
    return `${url.pathname}${url.search}`;
}

function buildCalibrationPath(sessionId: string) {
    const url = new URL(apiBaseUrl);
    url.pathname = `/api/sessions/${sessionId}/calibration`;
    url.search = "";
    return `${url.pathname}${url.search}`;
}

async function getPersistedCalibration(
    sessionId: string,
): Promise<PersistedCalibration | null> {
    const response = await apiFetch(buildCalibrationPath(sessionId), {
        cache: "no-store",
    });

    if (response.status === 204) {
        return null;
    }

    if (response.status === 401) {
        sessionStorage.removeItem(studentSessionStorageKey);
        throw new Error("受講セッションの有効期限が切れました。ログインし直してください。");
    }

    if (response.status === 403) {
        throw new Error("この受講セッションのキャリブレーション状態を確認する権限がありません。");
    }

    if (!response.ok) {
        throw new Error(
            `キャリブレーション状態の取得に失敗しました: ${response.status}`,
        );
    }

    const calibration = (await response.json()) as Partial<PersistedCalibration>;
    if (
        calibration.sessionId !== sessionId ||
        typeof calibration.earOpen !== "number" ||
        typeof calibration.earThreshold !== "number" ||
        typeof calibration.validFrames !== "number" ||
        typeof calibration.totalFrames !== "number" ||
        typeof calibration.sourceSequenceNo !== "number" ||
        typeof calibration.calibratedAt !== "string"
    ) {
        throw new Error("キャリブレーション状態の応答が不正です。");
    }

    return {
        type: "calibration_status",
        sessionId,
        status: "succeeded",
        validFrames: calibration.validFrames,
        totalFrames: calibration.totalFrames,
        targetFrames: calibration.totalFrames,
        sourceSequenceNo: calibration.sourceSequenceNo,
        calibratedAt: calibration.calibratedAt,
        earOpen: calibration.earOpen,
        earThreshold: calibration.earThreshold,
    };
}

function parseAnalysisEvent(value: unknown): AnalysisEvent | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }

    const parsed = value as Partial<AnalysisEvent>;
    if (
        parsed.type === "drowsiness_score" &&
        typeof parsed.sessionId === "string" &&
        typeof parsed.videoTimeSec === "number" &&
        Number.isFinite(parsed.videoTimeSec) &&
        parsed.videoTimeSec >= 0
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
