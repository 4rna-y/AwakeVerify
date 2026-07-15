"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    StoredStudentSession,
    studentSessionRoute,
    writeStoredStudentSession,
} from "./student-session-storage";
import { apiFetch } from "@/lib/api-client";

type LoginState = "idle" | "starting" | "error";

type StartSessionResponse = {
    sessionId: string;
};

export default function StudentPage({ lessonVideoId }: { lessonVideoId: string }) {
    const router = useRouter();
    const [loginState, setLoginState] = useState<LoginState>("idle");
    const [studentId, setStudentId] = useState("");
    const [message, setMessage] = useState<string | null>(null);

    async function startStudentSession(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const normalizedStudentId = studentId.trim();
        if (!normalizedStudentId) {
            setLoginState("error");
            setMessage("学籍番号を入力してください。");
            return;
        }

        setLoginState("starting");
        setMessage(null);

        try {
            const response = await apiFetch("/api/sessions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ studentId: normalizedStudentId, videoId: lessonVideoId }),
            });

            if (!response.ok) {
                throw new Error(`セッション開始に失敗しました: ${response.status}`);
            }

            const data = (await response.json()) as StartSessionResponse;
            const storedSession: StoredStudentSession = { sessionId: data.sessionId };

            writeStoredStudentSession(storedSession);
            router.push(studentSessionRoute);
        } catch (error) {
            setLoginState("error");
            setMessage(
                error instanceof Error
                    ? error.message
                    : "復旧不能なエラーが発生しました。",
            );
        }
    }

    const canSubmitStudent =
        loginState !== "starting" && studentId.trim().length > 0;

    return (
        <main className="relative min-h-dvh w-full overflow-x-hidden md:h-screen md:w-screen md:overflow-hidden">
            <Dialog open>
                <DialogContent
                    showCloseButton={false}
                    className="w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto md:w-full md:max-h-none md:overflow-visible"
                >
                    <DialogHeader>
                        <DialogTitle>生徒ログイン</DialogTitle>
                        <DialogDescription>
                            学籍番号を入力して受講セッションを開始します。
                        </DialogDescription>
                    </DialogHeader>

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
                                disabled={loginState === "starting"}
                                onChange={(event) =>
                                    setStudentId(event.target.value)
                                }
                            />
                        </div>
                        <Button disabled={!canSubmitStudent} type="submit">
                            {loginState === "starting" ? "開始中..." : "ログイン"}
                        </Button>
                        <Button
                            type="button"
                            variant="link"
                            onClick={() => router.push("/admin/login")}
                        >
                            管理者ログインはこちら
                        </Button>
                    </form>

                    {message && (
                        <Alert variant="destructive">
                            <AlertTitle>確認してください</AlertTitle>
                            <AlertDescription>{message}</AlertDescription>
                        </Alert>
                    )}
                </DialogContent>
            </Dialog>
        </main>
    );
}
