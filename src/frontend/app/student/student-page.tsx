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
    studentSessionStorageKey,
} from "./student-session-storage";

type LoginMode = "student" | "teacher";
type LoginState = "idle" | "starting" | "error";

type StartSessionResponse = {
    sessionId: string;
};

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";

export default function StudentPage() {
    const router = useRouter();
    const [loginMode, setLoginMode] = useState<LoginMode>("student");
    const [loginState, setLoginState] = useState<LoginState>("idle");
    const [studentId, setStudentId] = useState("");
    const [teacherId, setTeacherId] = useState("");
    const [teacherPassword, setTeacherPassword] = useState("");
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
            const storedSession: StoredStudentSession = {
                sessionId: data.sessionId,
                studentId: normalizedStudentId,
            };

            sessionStorage.setItem(
                studentSessionStorageKey,
                JSON.stringify(storedSession),
            );
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

    function submitTeacherLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setLoginState("error");
        setMessage("教員ログインは後続featureでAPI接続します。");
    }

    const canSubmitStudent =
        loginState !== "starting" && studentId.trim().length > 0;
    const canSubmitTeacher =
        teacherId.trim().length > 0 && teacherPassword.length > 0;

    return (
        <main className="relative h-screen w-screen overflow-hidden">
            <Dialog open>
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
                                    disabled={loginState === "starting"}
                                    onChange={(event) =>
                                        setStudentId(event.target.value)
                                    }
                                />
                            </div>
                            <Button disabled={!canSubmitStudent} type="submit">
                                {loginState === "starting"
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
