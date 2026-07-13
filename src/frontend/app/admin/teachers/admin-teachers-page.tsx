"use client";

import { FormEvent, useEffect, useState } from "react";

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
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { adminSessionStorageKey, StoredAdminSession } from "./admin-session-storage";

type LoginState = "idle" | "submitting" | "error";
type TeachersLoadState = "idle" | "loading" | "error";
type AddTeacherState = "idle" | "submitting" | "error";

type AdminLoginResponse = {
    success: boolean;
};

type TeacherSummary = {
    teacherId: string;
    createdAt: string;
    createdByAdminId: string | null;
};

const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";

export default function AdminTeachersPage() {
    const [adminId, setAdminId] = useState<string | null>(null);
    const [loginAdminId, setLoginAdminId] = useState("");
    const [loginPassword, setLoginPassword] = useState("");
    const [loginState, setLoginState] = useState<LoginState>("idle");
    const [loginMessage, setLoginMessage] = useState<string | null>(null);

    const [teachers, setTeachers] = useState<TeacherSummary[]>([]);
    const [teachersLoadState, setTeachersLoadState] =
        useState<TeachersLoadState>("idle");
    const [teachersMessage, setTeachersMessage] = useState<string | null>(
        null,
    );

    const [isAddTeacherOpen, setIsAddTeacherOpen] = useState(false);
    const [newTeacherId, setNewTeacherId] = useState("");
    const [newTeacherPassword, setNewTeacherPassword] = useState("");
    const [addTeacherState, setAddTeacherState] =
        useState<AddTeacherState>("idle");
    const [addTeacherMessage, setAddTeacherMessage] = useState<string | null>(
        null,
    );

    useEffect(() => {
        let isActive = true;

        async function loadStoredAdminSession() {
            await Promise.resolve();
            if (!isActive) {
                return;
            }

            const storedAdminId = readStoredAdminSession();
            if (storedAdminId) {
                setAdminId(storedAdminId);
            }
        }

        void loadStoredAdminSession();

        return () => {
            isActive = false;
        };
    }, []);

    useEffect(() => {
        if (adminId) {
            void loadTeachers();
        }
    }, [adminId]);

    async function loadTeachers() {
        setTeachersLoadState("loading");
        setTeachersMessage(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/admin/teachers`);

            if (!response.ok) {
                throw new Error(`教員一覧の取得に失敗しました: ${response.status}`);
            }

            const data = (await response.json()) as TeacherSummary[];
            setTeachers(data);
            setTeachersLoadState("idle");
        } catch (error) {
            setTeachersLoadState("error");
            setTeachersMessage(
                error instanceof Error
                    ? error.message
                    : "復旧不能なエラーが発生しました。",
            );
        }
    }

    async function submitAdminLogin(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const normalizedAdminId = loginAdminId.trim();
        if (!normalizedAdminId || !loginPassword) {
            setLoginState("error");
            setLoginMessage("管理者IDとパスワードを入力してください。");
            return;
        }

        setLoginState("submitting");
        setLoginMessage(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    adminId: normalizedAdminId,
                    password: loginPassword,
                }),
            });

            if (!response.ok) {
                throw new Error(`ログインに失敗しました: ${response.status}`);
            }

            const data = (await response.json()) as AdminLoginResponse;
            if (!data.success) {
                setLoginState("error");
                setLoginMessage("管理者IDまたはパスワードが正しくありません。");
                return;
            }

            const storedSession: StoredAdminSession = {
                adminId: normalizedAdminId,
            };
            sessionStorage.setItem(
                adminSessionStorageKey,
                JSON.stringify(storedSession),
            );
            setLoginPassword("");
            setLoginState("idle");
            setAdminId(normalizedAdminId);
        } catch (error) {
            setLoginState("error");
            setLoginMessage(
                error instanceof Error
                    ? error.message
                    : "復旧不能なエラーが発生しました。",
            );
        }
    }

    async function submitAddTeacher(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!adminId) {
            return;
        }

        const normalizedTeacherId = newTeacherId.trim();
        if (!normalizedTeacherId) {
            setAddTeacherState("error");
            setAddTeacherMessage("教員IDを入力してください。");
            return;
        }

        if (!newTeacherPassword) {
            setAddTeacherState("error");
            setAddTeacherMessage("パスワードを入力してください。");
            return;
        }

        setAddTeacherState("submitting");
        setAddTeacherMessage(null);

        try {
            const response = await fetch(`${apiBaseUrl}/api/admin/teachers`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    adminId,
                    teacherId: normalizedTeacherId,
                    password: newTeacherPassword,
                }),
            });

            if (!response.ok) {
                const detail = await response.text();
                throw new Error(
                    detail || `教員の追加に失敗しました: ${response.status}`,
                );
            }

            setNewTeacherId("");
            setNewTeacherPassword("");
            setAddTeacherState("idle");
            setIsAddTeacherOpen(false);
            await loadTeachers();
        } catch (error) {
            setAddTeacherState("error");
            setAddTeacherMessage(
                error instanceof Error
                    ? error.message
                    : "復旧不能なエラーが発生しました。",
            );
        }
    }

    const canSubmitLogin =
        loginState !== "submitting" &&
        loginAdminId.trim().length > 0 &&
        loginPassword.length > 0;
    const canSubmitAddTeacher =
        addTeacherState !== "submitting" &&
        newTeacherId.trim().length > 0 &&
        newTeacherPassword.length > 0;

    if (!adminId) {
        return (
            <main className="flex min-h-screen items-center justify-center p-6">
                <Card className="w-full max-w-sm">
                    <CardHeader>
                        <CardTitle>管理者ログイン</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <form
                            className="flex flex-col gap-4"
                            onSubmit={submitAdminLogin}
                        >
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="adminId">管理者ID</Label>
                                <Input
                                    id="adminId"
                                    value={loginAdminId}
                                    disabled={loginState === "submitting"}
                                    onChange={(event) =>
                                        setLoginAdminId(event.target.value)
                                    }
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <Label htmlFor="adminPassword">
                                    パスワード
                                </Label>
                                <Input
                                    id="adminPassword"
                                    type="password"
                                    value={loginPassword}
                                    disabled={loginState === "submitting"}
                                    onChange={(event) =>
                                        setLoginPassword(event.target.value)
                                    }
                                />
                            </div>
                            <Button disabled={!canSubmitLogin} type="submit">
                                {loginState === "submitting"
                                    ? "ログイン中..."
                                    : "ログイン"}
                            </Button>
                            {loginMessage && (
                                <Alert variant="destructive">
                                    <AlertTitle>確認してください</AlertTitle>
                                    <AlertDescription>
                                        {loginMessage}
                                    </AlertDescription>
                                </Alert>
                            )}
                        </form>
                    </CardContent>
                </Card>
            </main>
        );
    }

    return (
        <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>教員アカウント管理</CardTitle>
                    <Dialog
                        open={isAddTeacherOpen}
                        onOpenChange={(open) => {
                            setIsAddTeacherOpen(open);
                            if (!open) {
                                setAddTeacherState("idle");
                                setAddTeacherMessage(null);
                            }
                        }}
                    >
                        <DialogTrigger render={<Button />}>
                            教員を追加
                        </DialogTrigger>
                        <DialogContent className="w-full max-w-md">
                            <DialogHeader>
                                <DialogTitle>教員アカウントを追加</DialogTitle>
                                <DialogDescription>
                                    教員IDとパスワードを入力してください。
                                </DialogDescription>
                            </DialogHeader>
                            <form
                                className="flex flex-col gap-4"
                                onSubmit={submitAddTeacher}
                            >
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="newTeacherId">
                                        教員ID
                                    </Label>
                                    <Input
                                        id="newTeacherId"
                                        value={newTeacherId}
                                        disabled={
                                            addTeacherState === "submitting"
                                        }
                                        onChange={(event) =>
                                            setNewTeacherId(
                                                event.target.value,
                                            )
                                        }
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <Label htmlFor="newTeacherPassword">
                                        パスワード
                                    </Label>
                                    <Input
                                        id="newTeacherPassword"
                                        type="password"
                                        value={newTeacherPassword}
                                        disabled={
                                            addTeacherState === "submitting"
                                        }
                                        onChange={(event) =>
                                            setNewTeacherPassword(
                                                event.target.value,
                                            )
                                        }
                                    />
                                </div>
                                {addTeacherMessage && (
                                    <Alert variant="destructive">
                                        <AlertTitle>
                                            確認してください
                                        </AlertTitle>
                                        <AlertDescription>
                                            {addTeacherMessage}
                                        </AlertDescription>
                                    </Alert>
                                )}
                                <DialogFooter>
                                    <Button
                                        disabled={!canSubmitAddTeacher}
                                        type="submit"
                                    >
                                        {addTeacherState === "submitting"
                                            ? "追加中..."
                                            : "追加"}
                                    </Button>
                                </DialogFooter>
                            </form>
                        </DialogContent>
                    </Dialog>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                    {teachersMessage && (
                        <Alert variant="destructive">
                            <AlertTitle>確認してください</AlertTitle>
                            <AlertDescription>
                                {teachersMessage}
                            </AlertDescription>
                        </Alert>
                    )}
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>教員ID</TableHead>
                                <TableHead>追加日時</TableHead>
                                <TableHead>追加した管理者</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {teachers.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={3}
                                        className="text-center text-muted-foreground"
                                    >
                                        {teachersLoadState === "loading"
                                            ? "読み込み中..."
                                            : "教員が登録されていません。"}
                                    </TableCell>
                                </TableRow>
                            ) : (
                                teachers.map((teacher) => (
                                    <TableRow key={teacher.teacherId}>
                                        <TableCell>
                                            {teacher.teacherId}
                                        </TableCell>
                                        <TableCell>
                                            {formatDateTime(
                                                teacher.createdAt,
                                            )}
                                        </TableCell>
                                        <TableCell>
                                            {teacher.createdByAdminId ?? "-"}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </main>
    );
}

function readStoredAdminSession() {
    const storedSession = sessionStorage.getItem(adminSessionStorageKey);
    if (!storedSession) {
        return null;
    }

    try {
        const parsed = JSON.parse(storedSession) as Partial<StoredAdminSession>;
        if (typeof parsed.adminId !== "string" || parsed.adminId.length === 0) {
            return null;
        }

        return parsed.adminId;
    } catch {
        return null;
    }
}

function formatDateTime(isoDateTime: string) {
    try {
        return new Date(isoDateTime).toLocaleString("ja-JP");
    } catch {
        return isoDateTime;
    }
}
