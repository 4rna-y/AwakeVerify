"use client";

import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as signalR from "@microsoft/signalr";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch, apiUrl, getCurrentPrincipal, logout } from "@/lib/api-client";

type GuardState = "checking" | "authorized" | "forbidden";
type LoadState = "idle" | "loading" | "error";
type DrowsinessLevel = "normal" | "caution" | "warning" | "danger";
type ScoreSeriesKey = "score" | "perclos" | "ear";
type ScoreSeries = { key: ScoreSeriesKey; label: string; className: string; value: (score: Score) => number };
type HoveredScorePoint = { scoreIndex: number; seriesKey: ScoreSeriesKey }; 

type SessionSummary = {
    sessionId: string;
    latestLevel: DrowsinessLevel | null;
};

type SessionDetail = {
    sessionId: string;
    studentId: string;
    videoId: string;
    startedAt: string;
    endedAt: string | null;
};

type Score = {
    scoredAt: string;
    videoTimeSec: number | null;
    score: number;
    level: DrowsinessLevel;
    perclos: number;
    ear: number;
    pitchDeg: number;
    yawDeg: number;
};

type PlaybackEvent = {
    eventId: string;
    type: "auto_pause" | "resume";
    occurredAt: string;
    videoTimeSec: number | null;
};

type DrowsinessScoreEvent = Score & {
    type: "drowsiness_score";
    sessionId: string;
    shouldPause?: boolean;
};

type TrackingStatusEvent = {
    type: "tracking_status";
    sessionId: string;
    detectedAt: string;
    status: string;
};

type Calibration = {
    earOpen: number;
    earThreshold: number;
};

type CalibrationStatusEvent = Calibration & {
    type: "calibration_status";
    sessionId: string;
    status: "succeeded";
};

export default function AdminSessionPage({ sessionId }: { sessionId: string }) {
    const router = useRouter();
    const [guardState, setGuardState] = useState<GuardState>("checking");
    const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [latestLevel, setLatestLevel] = useState<DrowsinessLevel | null>(null);
    const [scores, setScores] = useState<Score[]>([]);
    const [playbackEvents, setPlaybackEvents] = useState<PlaybackEvent[]>([]);
    const [calibration, setCalibration] = useState<Calibration | null>(null);
    const [trackingStatus, setTrackingStatus] = useState<string | null>(null);
    const [detailLoadState, setDetailLoadState] = useState<LoadState>("idle");
    const [detailError, setDetailError] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
    const detailRequestId = useRef(0);

    const redirectToLogin = useCallback(() => {
        router.replace("/admin/login");
    }, [router]);

    const handleProtectedResponse = useCallback((response: Response) => {
        if (response.status === 401) {
            redirectToLogin();
            return true;
        }
        if (response.status === 403) {
            setGuardState("forbidden");
            setPermissionMessage("管理者権限がないため、この画面またはデータを表示できません。");
            return true;
        }
        return false;
    }, [redirectToLogin]);

    const loadSessionDetail = useCallback(async () => {
        const requestId = ++detailRequestId.current;
        setDetailLoadState("loading");
        setDetailError(null);
        try {
            const [detailResponse, scoresResponse, eventsResponse, sessionsResponse, calibrationResponse] = await Promise.all([
                apiFetch(`/api/dashboard/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" }),
                apiFetch(`/api/dashboard/sessions/${encodeURIComponent(sessionId)}/scores`, { cache: "no-store" }),
                apiFetch(`/api/dashboard/sessions/${encodeURIComponent(sessionId)}/playback-events`, { cache: "no-store" }),
                apiFetch("/api/dashboard/sessions", { cache: "no-store" }),
                apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/calibration`, { cache: "no-store" }),
            ]);
            const responses = [detailResponse, scoresResponse, eventsResponse, sessionsResponse, calibrationResponse];
            if (responses.some(handleProtectedResponse)) return;
            if ([detailResponse, scoresResponse, eventsResponse].some((response) => !response.ok) || (calibrationResponse.status !== 204 && !calibrationResponse.ok)) {
                throw new Error("選択したセッションの詳細を取得できませんでした。");
            }

            const [nextDetail, nextScores, nextEvents, nextCalibration] = await Promise.all([
                detailResponse.json() as Promise<SessionDetail>,
                scoresResponse.json() as Promise<Score[]>,
                eventsResponse.json() as Promise<PlaybackEvent[]>,
                calibrationResponse.status === 204 ? Promise.resolve(null) : calibrationResponse.json() as Promise<Calibration>,
            ]);
            const summaries = sessionsResponse.ok ? await sessionsResponse.json() as SessionSummary[] : [];
            if (requestId !== detailRequestId.current) return;
            setDetail(nextDetail);
            setScores(nextScores);
            setPlaybackEvents(nextEvents);
            setCalibration(nextCalibration);
            setLatestLevel(summaries.find((summary) => summary.sessionId === sessionId)?.latestLevel ?? null);
            setDetailLoadState("idle");
        } catch (error) {
            if (requestId !== detailRequestId.current) return;
            setDetailLoadState("error");
            setDetailError(error instanceof Error ? error.message : "セッション詳細を取得できませんでした。");
        }
    }, [handleProtectedResponse, sessionId]);

    useEffect(() => {
        let cancelled = false;
        void getCurrentPrincipal()
            .then(({ response, principal }) => {
                if (cancelled) return;
                if (response.status === 401) {
                    redirectToLogin();
                    return;
                }
                if (response.status === 403 || principal?.role !== "admin") {
                    setGuardState("forbidden");
                    setPermissionMessage("管理者権限がないため、セッション詳細を表示できません。");
                    return;
                }
                if (!response.ok) {
                    redirectToLogin();
                    return;
                }
                setGuardState("authorized");
                void loadSessionDetail();
            })
            .catch(() => {
                if (!cancelled) redirectToLogin();
            });

        return () => {
            cancelled = true;
        };
    }, [loadSessionDetail, redirectToLogin]);

    useEffect(() => {
        if (guardState !== "authorized") return;

        let active = true;
        void Promise.resolve().then(() => {
            if (active) setConnectionState("connecting");
        });
        const connection = new signalR.HubConnectionBuilder()
            .withUrl(apiUrl("/hubs/analysis-events"), { withCredentials: true })
            .withAutomaticReconnect()
            .build();

        connection.on("ReceiveAnalysisEvent", (payload: unknown) => {
            if (!active || !isRecord(payload) || payload.sessionId !== sessionId) return;
            if (isDrowsinessScoreEvent(payload)) {
                setScores((current) => upsertScore(current, payload));
                setLatestLevel(payload.level);
            } else if (isTrackingStatusEvent(payload)) {
                setTrackingStatus(payload.status);
            } else if (isCalibrationStatusEvent(payload)) {
                setCalibration({ earOpen: payload.earOpen, earThreshold: payload.earThreshold });
            }
        });
        connection.onreconnecting(() => {
            if (active) setConnectionState("connecting");
        });
        connection.onreconnected(() => {
            void (async () => {
                try {
                    await connection.invoke("JoinSession", sessionId);
                    if (!active) return;
                    setConnectionState("connected");
                    await loadSessionDetail();
                } catch {
                    if (active) setConnectionState("error");
                }
            })();
        });
        connection.onclose(() => {
            if (active) setConnectionState("error");
        });

        void (async () => {
            try {
                await connection.start();
                await connection.invoke("JoinSession", sessionId);
                if (active) setConnectionState("connected");
            } catch {
                if (active) setConnectionState("error");
            }
        })();

        return () => {
            active = false;
            void connection.stop();
        };
    }, [guardState, loadSessionDetail, sessionId]);

    async function handleLogout() {
        await logout().catch(() => undefined);
        router.replace("/admin/login");
    }

    if (guardState === "checking") {
        return (
            <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-64 w-full" />
            </main>
        );
    }

    if (guardState === "forbidden") {
        return (
            <main className="flex min-h-screen items-center justify-center p-6">
                <Alert variant="destructive" className="w-full max-w-md">
                    <AlertTitle>権限がありません</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3">
                        <span>{permissionMessage}</span>
                        <Button type="button" variant="outline" onClick={() => void handleLogout()}>ログアウト</Button>
                    </AlertDescription>
                </Alert>
            </main>
        );
    }

    return (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="outline" onClick={() => router.push("/admin/dashboard")}>一覧へ戻る</Button>
                    <h1 className="font-heading text-xl font-medium">セッション詳細</h1>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={connectionState === "error" ? "destructive" : "secondary"}>通知: {connectionStateLabel(connectionState)}</Badge>
                    <Button type="button" variant="outline" onClick={() => void loadSessionDetail()}>更新</Button>
                    <Button type="button" variant="outline" onClick={() => void handleLogout()}>ログアウト</Button>
                </div>
            </div>

            <Card>
                <CardHeader><CardTitle>セッション概要</CardTitle></CardHeader>
                <CardContent>
                    {detailLoadState === "loading" && !detail ? (
                        <div className="grid gap-2 md:grid-cols-4">
                            <Skeleton className="h-5 w-40" />
                            <Skeleton className="h-5 w-48" />
                            <Skeleton className="h-5 w-48" />
                            <Skeleton className="h-5 w-32" />
                        </div>
                    ) : detailError ? (
                        <Alert variant="destructive">
                            <AlertTitle>セッション詳細を読み込めません</AlertTitle>
                            <AlertDescription>{detailError}</AlertDescription>
                        </Alert>
                    ) : detail ? (
                        <div className="grid gap-3 md:grid-cols-5">
                            <span>動画 ID: {detail.videoId}</span>
                            <span>学籍番号: {detail.studentId}</span>
                            <span>開始: {formatDateTime(detail.startedAt)}</span>
                            <span>終了: {detail.endedAt ? formatDateTime(detail.endedAt) : "受講中"}</span>
                            <span>最新レベル: <LevelBadge level={latestLevel} /></span>
                            <span>トラッキング: <TrackingBadge status={trackingStatus} /></span>
                        </div>
                    ) : <p className="text-muted-foreground">セッション詳細はありません。</p>}
                </CardContent>
            </Card>

            <Card>
                <CardHeader><CardTitle>眠気スコア時系列</CardTitle></CardHeader>
                <CardContent>
                    {detailLoadState === "loading" && !detail ? <Skeleton className="h-80 w-full" /> : scores.length === 0 ? <p className="text-muted-foreground">眠気スコアはまだありません。</p> : <ScoreChart scores={scores} events={playbackEvents} calibration={calibration} />}
                </CardContent>
            </Card>
        </main>
    );
}

function LevelBadge({ level }: { level: DrowsinessLevel | null }) {
    const variant = level === "danger" ? "destructive" : level === "warning" ? "outline" : level === "caution" ? "secondary" : "default";
    return <Badge variant={variant}>{level ?? "未測定"}</Badge>;
}

function TrackingBadge({ status }: { status: string | null }) {
    return <Badge variant={status === "face_not_detected" ? "destructive" : "secondary"}>{status ?? "未受信"}</Badge>;
}

function ScoreChart({ scores, events, calibration }: { scores: Score[]; events: PlaybackEvent[]; calibration: Calibration | null }) {
    const [showPerclos, setShowPerclos] = useState(false);
    const [showEar, setShowEar] = useState(false);
    const [hoveredPoint, setHoveredPoint] = useState<HoveredScorePoint | null>(null);
    const chart = { width: 900, height: 350, left: 92, right: 24, top: 20, bottom: 82 };
    const plotWidth = chart.width - chart.left - chart.right;
    const plotHeight = chart.height - chart.top - chart.bottom;
    const orderedScores = [...scores].sort((left, right) => left.scoredAt.localeCompare(right.scoredAt));
    const startTime = new Date(orderedScores[0].scoredAt).getTime();
    const endTime = new Date(orderedScores.at(-1)?.scoredAt ?? orderedScores[0].scoredAt).getTime();
    const hasTimeRange = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
    const xForScore = (score: Score, index: number) => {
        if (!hasTimeRange) return chart.left + plotWidth / 2;
        const timestamp = new Date(score.scoredAt).getTime();
        if (!Number.isFinite(timestamp)) return chart.left + (index / Math.max(orderedScores.length - 1, 1)) * plotWidth;
        return chart.left + Math.min(1, Math.max(0, (timestamp - startTime) / (endTime - startTime))) * plotWidth;
    };
    const xForTimestamp = (timestamp: number) => chart.left + Math.min(1, Math.max(0, (timestamp - startTime) / (endTime - startTime))) * plotWidth;
    const yForValue = (value: number) => chart.top + (1 - Math.min(1, Math.max(0, value))) * plotHeight;
    const visibleSeries: ScoreSeries[] = [
        { key: "score", label: "score", className: "text-primary", value: (score: Score) => score.score },
        ...(showPerclos ? [{ key: "perclos" as const, label: "PERCLOS", className: "text-destructive", value: (score: Score) => score.perclos }] : []),
        ...(showEar ? [{ key: "ear" as const, label: "EAR", className: "text-muted-foreground", value: (score: Score) => score.ear }] : []),
    ];
    const pauseIntervals = hasTimeRange ? getPauseIntervals(events, startTime, endTime) : [];
    const scoreIntervals = hasTimeRange ? getScoreIntervals(orderedScores, startTime, endTime) : [];
    const xTicks = getChartXTicks(orderedScores, xForScore);
    const hoveredScore = hoveredPoint === null ? null : orderedScores[hoveredPoint.scoreIndex] ?? null;
    const hoveredSeries = hoveredPoint === null ? null : visibleSeries.find((series) => series.key === hoveredPoint.seriesKey) ?? null;
    const hoveredScoreX = hoveredScore === null || hoveredPoint === null ? null : xForScore(hoveredScore, hoveredPoint.scoreIndex);
    const hoveredScoreY = hoveredScore === null || hoveredSeries === null ? null : yForValue(hoveredSeries.value(hoveredScore));
    const tooltipX = hoveredScoreX === null ? 0 : Math.min(chart.left + plotWidth - 208, Math.max(chart.left + 8, hoveredScoreX + 12));
    const tooltipY = hoveredScoreY === null ? 0 : Math.min(chart.top + plotHeight - 138, Math.max(chart.top + 8, hoveredScoreY - 146));

    function handleSeriesPointerMove(series: ScoreSeries, event: PointerEvent<SVGGElement>) {
        const svg = event.currentTarget.ownerSVGElement;
        if (!svg) return;
        const bounds = svg.getBoundingClientRect();
        const pointerX = ((event.clientX - bounds.left) / bounds.width) * chart.width;
        const pointerY = ((event.clientY - bounds.top) / bounds.height) * chart.height;
        const nearestIndex = orderedScores.reduce((nearest, score, index) => {
            const distance = Math.hypot(xForScore(score, index) - pointerX, yForValue(series.value(score)) - pointerY);
            const nearestDistance = Math.hypot(xForScore(orderedScores[nearest], nearest) - pointerX, yForValue(series.value(orderedScores[nearest])) - pointerY);
            return distance < nearestDistance ? index : nearest;
        }, 0);
        setHoveredPoint({ scoreIndex: nearestIndex, seriesKey: series.key });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="text-primary">score</span>
                <label className="flex items-center gap-2">
                    <Checkbox checked={showPerclos} onCheckedChange={(checked) => { setShowPerclos(checked === true); setHoveredPoint(null); }} aria-label="PERCLOS を表示" />
                    PERCLOS を表示
                </label>
                <label className="flex items-center gap-2">
                    <Checkbox checked={showEar} onCheckedChange={(checked) => { setShowEar(checked === true); setHoveredPoint(null); }} aria-label="EAR を表示" />
                    EAR を表示
                </label>
                {(showPerclos || showEar) && <span className="text-muted-foreground">{calibration ? `PERCLOS 基準: EAR < ${calibration.earThreshold.toFixed(2)}` : "キャリブレーション情報なし"}</span>}
            </div>
            <svg className="h-auto w-full" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="眠気スコア時系列グラフ。縦軸は値、横軸は時刻、自動停止区間を網掛けで表示しています。score、PERCLOS、EAR の線にホバーすると詳細を表示します。">
                <g className="text-primary">
                    <rect x={chart.left} y={chart.top} width={plotWidth} height={yForValue(0.75) - chart.top} fill="currentColor" fillOpacity="0.08" />
                    <line x1={chart.left} x2={chart.left + plotWidth} y1={yForValue(0.75)} y2={yForValue(0.75)} stroke="currentColor" strokeDasharray="6 5" strokeWidth="1.5" />
                    <text x={chart.left + plotWidth - 4} y={yForValue(0.75) - 6} textAnchor="end" className="fill-primary">danger 0.75</text>
                </g>
                {pauseIntervals.map((interval) => {
                    const x = xForTimestamp(interval.start);
                    const endX = xForTimestamp(interval.end);
                    return <g key={`${interval.start}-${interval.end}`} className="text-destructive"><title>{`自動停止: ${formatDateTime(new Date(interval.start).toISOString())} から ${formatDateTime(new Date(interval.end).toISOString())}`}</title><rect x={x} y={chart.top} width={Math.max(endX - x, 2)} height={plotHeight} fill="currentColor" fillOpacity="0.12" /></g>;
                })}
                {showEar && calibration !== null && [{ label: "EAR open", value: calibration.earOpen, className: "text-chart-1" }, { label: "EAR threshold", value: calibration.earThreshold, className: "text-destructive" }].map((reference) => <g key={reference.label} className={reference.className}><line x1={chart.left} x2={chart.left + plotWidth} y1={yForValue(reference.value)} y2={yForValue(reference.value)} stroke="currentColor" strokeDasharray="4 3" strokeWidth="1.5" /><text x={chart.left + plotWidth - 4} y={yForValue(reference.value) - 6} textAnchor="end" className="fill-current">{`${reference.label} ${reference.value.toFixed(2)}`}</text></g>)}
                {[0, 0.25, 0.5, 0.75, 1].map((value) => <g key={value}><line x1={chart.left} x2={chart.left + plotWidth} y1={yForValue(value)} y2={yForValue(value)} stroke="currentColor" strokeOpacity="0.15" /><text x={chart.left - 10} y={yForValue(value) + 4} textAnchor="end" className="fill-muted-foreground">{value.toFixed(value === 0 || value === 1 ? 0 : 2)}</text></g>)}
                <line x1={chart.left} x2={chart.left} y1={chart.top} y2={chart.top + plotHeight} stroke="currentColor" strokeOpacity="0.5" />
                <line x1={chart.left} x2={chart.left + plotWidth} y1={chart.top + plotHeight} y2={chart.top + plotHeight} stroke="currentColor" strokeOpacity="0.5" />
                {xTicks.map((tick) => <g key={tick.key}><line x1={tick.x} x2={tick.x} y1={chart.top + plotHeight} y2={chart.top + plotHeight + 5} stroke="currentColor" strokeOpacity="0.5" /><text x={tick.x} y={chart.top + plotHeight + 21} textAnchor="middle" className="fill-muted-foreground">{tick.timeLabel}</text><text x={tick.x} y={chart.top + plotHeight + 42} textAnchor="middle" className="fill-muted-foreground">{tick.videoTimeLabel}</text></g>)}
                {visibleSeries.map((series) => <g key={series.key} className={series.className} onPointerMove={(event) => handleSeriesPointerMove(series, event)} onPointerLeave={() => setHoveredPoint(null)}><polyline fill="none" stroke="currentColor" strokeWidth="3" points={orderedScores.map((score, index) => `${xForScore(score, index)},${yForValue(series.value(score))}`).join(" ")} />{orderedScores.map((score, index) => <circle key={`${series.key}-${score.scoredAt}`} cx={xForScore(score, index)} cy={yForValue(series.value(score))} r="3" fill="currentColor" />)}<polyline fill="none" stroke="transparent" strokeWidth="16" points={orderedScores.map((score, index) => `${xForScore(score, index)},${yForValue(series.value(score))}`).join(" ")} /></g>)}
                {hoveredScore !== null && hoveredSeries !== null && hoveredScoreX !== null && hoveredScoreY !== null && <g pointerEvents="none">
                    <line x1={hoveredScoreX} x2={hoveredScoreX} y1={chart.top} y2={chart.top + plotHeight} className="stroke-muted-foreground" strokeDasharray="4 4" strokeOpacity="0.7" />
                    <g className={hoveredSeries.className}><circle cx={hoveredScoreX} cy={hoveredScoreY} r="6" className="fill-background" stroke="currentColor" strokeWidth="3" /></g>
                    <rect x={tooltipX} y={tooltipY} width="200" height="132" rx="6" className="fill-popover stroke-border" />
                    <text x={tooltipX + 12} y={tooltipY + 18} className="fill-popover-foreground" fontSize="12">{formatDateTime(hoveredScore.scoredAt)}</text>
                    <text x={tooltipX + 12} y={tooltipY + 37} className="fill-popover-foreground" fontSize="12">{`動画位置: ${formatVideoTimeSec(hoveredScore.videoTimeSec)}`}</text>
                    <text x={tooltipX + 12} y={tooltipY + 56} className="fill-popover-foreground" fontSize="12">{`level: ${hoveredScore.level}`}</text>
                    <text x={tooltipX + 12} y={tooltipY + 75} className="fill-popover-foreground" fontSize="12">{`score: ${hoveredScore.score.toFixed(2)}`}</text>
                    <text x={tooltipX + 104} y={tooltipY + 75} className="fill-popover-foreground" fontSize="12">{`PERCLOS: ${hoveredScore.perclos.toFixed(2)}`}</text>
                    <text x={tooltipX + 12} y={tooltipY + 94} className="fill-popover-foreground" fontSize="12">{`EAR: ${hoveredScore.ear.toFixed(2)}`}</text>
                    <text x={tooltipX + 12} y={tooltipY + 113} className="fill-popover-foreground" fontSize="12">{calibration ? `EAR 基準: open ${calibration.earOpen.toFixed(2)} / threshold ${calibration.earThreshold.toFixed(2)}` : "EAR 基準: 未取得"}</text>
                </g>}
                <text x="16" y={chart.top + plotHeight / 2} textAnchor="middle" transform={`rotate(-90 16 ${chart.top + plotHeight / 2})`} className="fill-muted-foreground">値</text>
                <text x={chart.left - 8} y={chart.top + plotHeight + 21} textAnchor="end" className="fill-muted-foreground">時刻</text>
                <text x={chart.left - 8} y={chart.top + plotHeight + 42} textAnchor="end" className="fill-muted-foreground">動画位置 (秒)</text>
            </svg>

            <svg className="h-auto w-full" viewBox={`0 0 ${chart.width} 88`} role="img" aria-label="スコアタイムライン。normal、caution、warning、danger を色で表示しています。">
                <text x={chart.left} y="14" className="fill-muted-foreground">スコアタイムライン</text>
                <rect x={chart.left} y="26" width={plotWidth} height="20" rx="4" className="fill-muted" />
                {scoreIntervals.map((interval) => {
                    const x = xForTimestamp(interval.start);
                    const endX = xForTimestamp(interval.end);
                    const style = scoreLevelTimelineStyles[interval.level];
                    return <g key={`${interval.level}-${interval.start}-${interval.end}`} className={style.className}><title>{`${style.label}: ${formatDateTime(new Date(interval.start).toISOString())} から ${formatDateTime(new Date(interval.end).toISOString())}`}</title><rect x={x} y="26" width={Math.max(endX - x, 2)} height="20" rx="4" fill="currentColor" /></g>;
                })}
                {Object.entries(scoreLevelTimelineStyles).map(([level, style], index) => {
                    const x = chart.left + index * 150;
                    return <g key={level} className={style.className}><rect x={x} y="62" width="12" height="12" rx="2" fill="currentColor" /><text x={x + 18} y="72" className="fill-foreground">{style.label}</text></g>;
                })}
            </svg>
        </div>
    );
}

type PauseInterval = { start: number; end: number };
type ScoreInterval = PauseInterval & { level: DrowsinessLevel };

const scoreLevelTimelineStyles: Record<DrowsinessLevel, { className: string; label: string }> = {
    normal: { className: "text-chart-1", label: "normal" },
    caution: { className: "text-chart-2", label: "caution" },
    warning: { className: "text-chart-3", label: "warning" },
    danger: { className: "text-destructive", label: "danger" },
};

function getPauseIntervals(events: PlaybackEvent[], chartStart: number, chartEnd: number): PauseInterval[] {
    let pausedAt: number | null = null;
    const intervals: PauseInterval[] = [];

    for (const event of [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))) {
        const occurredAt = new Date(event.occurredAt).getTime();
        if (!Number.isFinite(occurredAt)) continue;
        if (event.type === "auto_pause" && pausedAt === null) pausedAt = occurredAt;
        if (event.type === "resume" && pausedAt !== null) {
            intervals.push({ start: Math.max(pausedAt, chartStart), end: Math.min(occurredAt, chartEnd) });
            pausedAt = null;
        }
    }
    if (pausedAt !== null) intervals.push({ start: Math.max(pausedAt, chartStart), end: chartEnd });
    return intervals.filter((interval) => interval.end >= interval.start && interval.end >= chartStart && interval.start <= chartEnd);
}

function getScoreIntervals(scores: Score[], chartStart: number, chartEnd: number): ScoreInterval[] {
    const intervals: ScoreInterval[] = [];

    for (const [index, score] of scores.entries()) {
        const scoredAt = new Date(score.scoredAt).getTime();
        const nextScoredAt = new Date(scores[index + 1]?.scoredAt ?? score.scoredAt).getTime();
        if (!Number.isFinite(scoredAt) || !Number.isFinite(nextScoredAt)) continue;

        const interval = {
            level: score.level,
            start: index === 0 ? chartStart : Math.max(scoredAt, chartStart),
            end: index === scores.length - 1 ? chartEnd : Math.min(nextScoredAt, chartEnd),
        };
        const previous = intervals.at(-1);
        if (previous?.level === interval.level && previous.end === interval.start) previous.end = interval.end;
        else intervals.push(interval);
    }

    return intervals.filter((interval) => interval.end >= interval.start);
}

function getChartXTicks(scores: Score[], xForScore: (score: Score, index: number) => number) {
    const tickCount = Math.min(5, scores.length);
    const indexes = [...new Set(Array.from({ length: tickCount }, (_, index) => Math.round((index * (scores.length - 1)) / Math.max(tickCount - 1, 1))))];
    return indexes.map((index) => {
        const score = scores[index];
        return {
            key: `${score.scoredAt}-${index}`,
            x: xForScore(score, index),
            timeLabel: formatChartTime(score.scoredAt),
            videoTimeLabel: score.videoTimeSec === null ? "—" : score.videoTimeSec.toFixed(2),
        };
    });
}

function formatChartTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatVideoTimeSec(value: number | null) {
    return value === null ? "—" : `${value.toFixed(2)} 秒`;
}

function formatDateTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP");
}

function connectionStateLabel(state: "idle" | "connecting" | "connected" | "error") {
    return { idle: "未接続", connecting: "接続中", connected: "接続済み", error: "エラー" }[state];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isDrowsinessLevel(value: unknown): value is DrowsinessLevel {
    return value === "normal" || value === "caution" || value === "warning" || value === "danger";
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isDrowsinessScoreEvent(value: Record<string, unknown>): value is DrowsinessScoreEvent {
    return value.type === "drowsiness_score" && typeof value.sessionId === "string" && typeof value.scoredAt === "string" && isFiniteNumber(value.videoTimeSec) && value.videoTimeSec >= 0 && isFiniteNumber(value.score) && isDrowsinessLevel(value.level) && isFiniteNumber(value.perclos) && isFiniteNumber(value.ear) && isFiniteNumber(value.pitchDeg) && isFiniteNumber(value.yawDeg);
}

function isTrackingStatusEvent(value: Record<string, unknown>): value is TrackingStatusEvent {
    return value.type === "tracking_status" && typeof value.sessionId === "string" && typeof value.detectedAt === "string" && typeof value.status === "string";
}

function isCalibrationStatusEvent(value: Record<string, unknown>): value is CalibrationStatusEvent {
    return value.type === "calibration_status" && typeof value.sessionId === "string" && value.status === "succeeded" && isFiniteNumber(value.earOpen) && value.earOpen > 0 && isFiniteNumber(value.earThreshold) && value.earThreshold > 0;
}

function upsertScore(scores: Score[], nextScore: Score) {
    const existingIndex = scores.findIndex((score) => score.scoredAt === nextScore.scoredAt);
    if (existingIndex === -1) return [...scores, nextScore].sort((left, right) => left.scoredAt.localeCompare(right.scoredAt));
    return scores.map((score, index) => index === existingIndex ? nextScore : score);
}
