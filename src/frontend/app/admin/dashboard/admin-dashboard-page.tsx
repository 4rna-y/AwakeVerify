"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { apiFetch, getCurrentPrincipal, logout } from "@/lib/api-client";

type GuardState = "checking" | "authorized" | "forbidden";
type LoadState = "idle" | "loading" | "error";
type DrowsinessLevel = "normal" | "caution" | "warning" | "danger";

type SessionSummary = {
    sessionId: string;
    studentId: string;
    videoId: string;
    startedAt: string;
    endedAt: string | null;
    latestLevel: DrowsinessLevel | null;
};

const drowsinessLevels: Array<DrowsinessLevel | ""> = ["", "normal", "caution", "warning", "danger"];

export default function AdminDashboardPage() {
    const router = useRouter();
    const [guardState, setGuardState] = useState<GuardState>("checking");
    const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [sessionsLoadState, setSessionsLoadState] = useState<LoadState>("idle");
    const [sessionsError, setSessionsError] = useState<string | null>(null);
    const [studentFilter, setStudentFilter] = useState("");
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const [levelFilter, setLevelFilter] = useState<DrowsinessLevel | "">("");
    const [videoFilter, setVideoFilter] = useState("");
    const [pendingDeleteSession, setPendingDeleteSession] = useState<SessionSummary | null>(null);
    const [deletionState, setDeletionState] = useState<"idle" | "deleting" | "error">("idle");
    const [deletionError, setDeletionError] = useState<string | null>(null);

    const redirectToLogin = useCallback(() => {
        router.replace("/admin/login");
    }, [router]);

    const handleProtectedResponse = useCallback(
        (response: Response) => {
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
        },
        [redirectToLogin],
    );

    const loadSessions = useCallback(async () => {
        setSessionsLoadState("loading");
        setSessionsError(null);
        try {
            const response = await apiFetch("/api/dashboard/sessions", { cache: "no-store" });
            if (handleProtectedResponse(response)) return;
            if (!response.ok) {
                throw new Error(`セッション一覧の取得に失敗しました: ${response.status}`);
            }

            setSessions(await response.json() as SessionSummary[]);
            setSessionsLoadState("idle");
        } catch (error) {
            setSessionsLoadState("error");
            setSessionsError(error instanceof Error ? error.message : "セッション一覧を取得できませんでした。");
        }
    }, [handleProtectedResponse]);

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
                    setPermissionMessage("管理者権限がないため、ダッシュボードを表示できません。");
                    return;
                }
                if (!response.ok) {
                    redirectToLogin();
                    return;
                }
                setGuardState("authorized");
                void loadSessions();
            })
            .catch(() => {
                if (!cancelled) redirectToLogin();
            });

        return () => {
            cancelled = true;
        };
    }, [loadSessions, redirectToLogin]);

    const filteredSessions = useMemo(() => {
        const normalizedStudentFilter = studentFilter.trim().toLocaleLowerCase();
        const normalizedVideoFilter = videoFilter.trim().toLocaleLowerCase();
        return sessions.filter((session) => {
            const sessionDate = session.startedAt.slice(0, 10);
            const matchesStudent = normalizedStudentFilter.length === 0 || session.studentId.toLocaleLowerCase().includes(normalizedStudentFilter);
            const matchesVideo = normalizedVideoFilter.length === 0 || session.videoId.toLocaleLowerCase().includes(normalizedVideoFilter);
            const matchesFrom = fromDate.length === 0 || sessionDate >= fromDate;
            const matchesTo = toDate.length === 0 || sessionDate <= toDate;
            const matchesLevel = levelFilter.length === 0 || session.latestLevel === levelFilter;
            return matchesStudent && matchesVideo && matchesFrom && matchesTo && matchesLevel;
        });
    }, [fromDate, levelFilter, sessions, studentFilter, toDate, videoFilter]);

    async function handleLogout() {
        await logout().catch(() => undefined);
        router.replace("/admin/login");
    }

    function resetFilters() {
        setStudentFilter("");
        setFromDate("");
        setToDate("");
        setLevelFilter("");
        setVideoFilter("");
    }

    function requestSessionDeletion(session: SessionSummary) {
        setDeletionError(null);
        setDeletionState("idle");
        setPendingDeleteSession(session);
    }

    async function deleteSession() {
        if (!pendingDeleteSession) return;

        setDeletionState("deleting");
        setDeletionError(null);
        try {
            const response = await apiFetch(`/api/dashboard/sessions/${pendingDeleteSession.sessionId}`, {
                method: "DELETE",
            });
            if (handleProtectedResponse(response)) return;
            if (!response.ok) {
                throw new Error(`受講記録の削除に失敗しました: ${response.status}`);
            }

            const deletedSessionId = pendingDeleteSession.sessionId;
            setSessions((current) => current.filter((session) => session.sessionId !== deletedSessionId));
            setPendingDeleteSession(null);
            setDeletionState("idle");
        } catch (error) {
            setDeletionState("error");
            setDeletionError(error instanceof Error ? error.message : "受講記録を削除できませんでした。");
        }
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
                        <Button type="button" variant="outline" onClick={() => void handleLogout()}>
                            ログアウト
                        </Button>
                    </AlertDescription>
                </Alert>
            </main>
        );
    }

    return (
        <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 className="font-heading text-xl font-medium">管理者ダッシュボード</h1>
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" onClick={() => void loadSessions()}>
                        更新
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void handleLogout()}>
                        ログアウト
                    </Button>
                </div>
            </div>

            {sessionsError && (
                <Alert variant="destructive">
                    <AlertTitle>セッション一覧を読み込めません</AlertTitle>
                    <AlertDescription>{sessionsError}</AlertDescription>
                </Alert>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>フィルタ</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
                    <div className="grid gap-2">
                        <Label htmlFor="student-filter">学籍番号</Label>
                        <Input id="student-filter" value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)} placeholder="学籍番号で検索" />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="video-filter">動画 ID</Label>
                        <Input id="video-filter" value={videoFilter} onChange={(event) => setVideoFilter(event.target.value)} placeholder="動画 ID で検索" />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="from-date">開始日（From）</Label>
                        <Input id="from-date" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="to-date">開始日（To）</Label>
                        <Input id="to-date" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="level-filter">眠気レベル</Label>
                        <select id="level-filter" value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as DrowsinessLevel | "")} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm">
                            {drowsinessLevels.map((level) => (
                                <option key={level || "all"} value={level}>
                                    {level || "すべて"}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-end">
                        <Button type="button" variant="outline" onClick={resetFilters}>
                            条件をクリア
                        </Button>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>受講セッション（{filteredSessions.length}件）</CardTitle>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>動画 ID</TableHead>
                                <TableHead>学籍番号</TableHead>
                                <TableHead>開始時刻</TableHead>
                                <TableHead>終了時刻</TableHead>
                                <TableHead>操作</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {sessionsLoadState === "loading" && sessions.length === 0 ? (
                                <LoadingRows />
                            ) : filteredSessions.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                                        {sessions.length === 0 ? "セッションがありません。" : "条件に一致するセッションがありません。"}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredSessions.map((session) => (
                                    <TableRow key={session.sessionId}>
                                        <TableCell>{session.videoId}</TableCell>
                                        <TableCell>{session.studentId}</TableCell>
                                        <TableCell>{formatDateTime(session.startedAt)}</TableCell>
                                        <TableCell>{session.endedAt ? formatDateTime(session.endedAt) : "受講中"}</TableCell>
                                        <TableCell>
                                            <div className="flex flex-wrap gap-2">
                                                <Button type="button" variant="outline" onClick={() => router.push(`/admin/dashboard/sessions/${encodeURIComponent(session.sessionId)}`)} disabled={deletionState === "deleting"}>
                                                    表示
                                                </Button>
                                                <Button type="button" variant="destructive" onClick={() => requestSessionDeletion(session)} disabled={deletionState === "deleting"}>
                                                    削除
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Dialog open={pendingDeleteSession !== null} onOpenChange={(open) => {
                if (!open && deletionState !== "deleting") {
                    setPendingDeleteSession(null);
                    setDeletionError(null);
                    setDeletionState("idle");
                }
            }}>
                <DialogContent showCloseButton={deletionState !== "deleting"}>
                    <DialogHeader>
                        <DialogTitle>受講記録を削除しますか？</DialogTitle>
                        <DialogDescription>
                            動画 ID「{pendingDeleteSession?.videoId}」の学籍番号「{pendingDeleteSession?.studentId}」の受講セッションと、眠気スコア・停止／再開イベント・キャリブレーション記録を削除します。この操作は取り消せません。
                        </DialogDescription>
                    </DialogHeader>
                    {deletionError && (
                        <Alert variant="destructive">
                            <AlertTitle>受講記録を削除できません</AlertTitle>
                            <AlertDescription>{deletionError}</AlertDescription>
                        </Alert>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => setPendingDeleteSession(null)} disabled={deletionState === "deleting"}>
                            キャンセル
                        </Button>
                        <Button type="button" variant="destructive" onClick={() => void deleteSession()} disabled={deletionState === "deleting"}>
                            {deletionState === "deleting" ? "削除中..." : "削除する"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </main>
    );
}

function LoadingRows() {
    return <>{[1, 2, 3].map((row) => <TableRow key={row}>{[1, 2, 3, 4, 5].map((cell) => <TableCell key={cell}><Skeleton className="h-5 w-full" /></TableCell>)}</TableRow>)}</>;
}

function formatDateTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP");
}
