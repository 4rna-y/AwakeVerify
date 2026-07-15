"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    apiFetch,
    getCurrentPrincipal,
    isAuthenticatedResponse,
    logout,
} from "@/lib/api-client";

type GuardState = "checking" | "unauthenticated" | "forbidden";
type SubmitState = "idle" | "submitting" | "error";

export default function AdminLoginPage() {
    const router = useRouter();
    const [guardState, setGuardState] = useState<GuardState>("checking");
    const [adminId, setAdminId] = useState("");
    const [password, setPassword] = useState("");
    const [submitState, setSubmitState] = useState<SubmitState>("idle");
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        void getCurrentPrincipal()
            .then(({ response, principal }) => {
                if (cancelled) return;
                if (response.status === 401) {
                    setGuardState("unauthenticated");
                    return;
                }
                if (!response.ok || principal?.role !== "admin") {
                    setGuardState("forbidden");
                    setMessage("この画面を表示する権限がありません。");
                    return;
                }
                router.replace("/admin/dashboard");
            })
            .catch(() => {
                if (!cancelled) {
                    setGuardState("unauthenticated");
                    setMessage("認証状態を確認できませんでした。もう一度ログインしてください。");
                }
            });

        return () => {
            cancelled = true;
        };
    }, [router]);

    async function submitLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const normalizedAdminId = adminId.trim();

        if (!normalizedAdminId || !password) {
            setSubmitState("error");
            setMessage("管理者IDとパスワードを入力してください。");
            return;
        }

        setSubmitState("submitting");
        setMessage(null);
        try {
            const response = await apiFetch("/api/admin/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ adminId: normalizedAdminId, password }),
            });
            const payload: unknown = response.ok ? await response.json() : null;
            if (!response.ok || !isAuthenticatedResponse(payload)) {
                setSubmitState("error");
                setMessage("管理者IDまたはパスワードが正しくありません。");
                return;
            }

            setPassword("");
            router.replace("/admin/dashboard");
        } catch {
            setSubmitState("error");
            setMessage("ログイン通信に失敗しました。接続を確認して再試行してください。");
        }
    }

    async function submitLogout() {
        await logout().catch(() => undefined);
        setGuardState("unauthenticated");
        setMessage("ログアウトしました。");
    }

    if (guardState === "checking") {
        return <main className="min-h-dvh p-4 md:min-h-screen md:p-6">認証状態を確認しています...</main>;
    }

    if (guardState === "forbidden") {
        return (
            <main className="flex min-h-dvh items-center justify-center overflow-y-auto p-4 md:min-h-screen md:p-6">
                <Alert variant="destructive" className="w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto md:max-h-none md:overflow-visible">
                    <AlertTitle>権限がありません</AlertTitle>
                    <AlertDescription className="flex flex-col gap-3">
                        <span>{message}</span>
                        <Button type="button" variant="outline" onClick={() => void submitLogout()}>
                            ログアウト
                        </Button>
                    </AlertDescription>
                </Alert>
            </main>
        );
    }

    const canSubmit = submitState !== "submitting" && !!adminId.trim() && !!password;
    return (
        <main className="flex min-h-dvh items-center justify-center overflow-y-auto p-4 md:min-h-screen md:p-6">
            <Card className="w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto md:max-h-none md:overflow-visible">
                <CardHeader><CardTitle>管理者ログイン</CardTitle></CardHeader>
                <CardContent>
                    <form className="flex flex-col gap-4" onSubmit={submitLogin}>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="adminId">管理者ID</Label>
                            <Input id="adminId" value={adminId} disabled={submitState === "submitting"} onChange={(event) => setAdminId(event.target.value)} />
                        </div>
                        <div className="flex flex-col gap-2">
                            <Label htmlFor="adminPassword">パスワード</Label>
                            <Input id="adminPassword" type="password" value={password} disabled={submitState === "submitting"} onChange={(event) => setPassword(event.target.value)} />
                        </div>
                        <Button disabled={!canSubmit} type="submit">
                            {submitState === "submitting" ? "ログイン中..." : "ログイン"}
                        </Button>
                        {message && <Alert variant="destructive"><AlertTitle>確認してください</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
                    </form>
                </CardContent>
            </Card>
        </main>
    );
}
