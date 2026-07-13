"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    StoredTeacherSession,
    teacherSessionStorageKey,
} from "../teacher-session-storage";

type GuardState = "checking" | "authorized";

export default function TeacherDashboardPage() {
    const router = useRouter();
    const [guardState, setGuardState] = useState<GuardState>("checking");
    const [teacherId, setTeacherId] = useState<string | null>(null);

    useEffect(() => {
        let isActive = true;

        async function checkStoredTeacherSession() {
            await Promise.resolve();
            if (!isActive) {
                return;
            }

            const storedTeacherId = readStoredTeacherId();
            if (!storedTeacherId) {
                router.replace("/student");
                return;
            }

            setTeacherId(storedTeacherId);
            setGuardState("authorized");
        }

        void checkStoredTeacherSession();

        return () => {
            isActive = false;
        };
    }, [router]);

    if (guardState !== "authorized") {
        return null;
    }

    return (
        <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
            <Card>
                <CardHeader>
                    <CardTitle>教員ダッシュボード</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-muted-foreground">
                        {teacherId} さんとしてログインしています。教員ダッシュボードの詳細機能は今後の feature
                        で実装されます。
                    </p>
                </CardContent>
            </Card>
        </main>
    );
}

function readStoredTeacherId() {
    const storedSession = sessionStorage.getItem(teacherSessionStorageKey);
    if (!storedSession) {
        return null;
    }

    try {
        const parsed = JSON.parse(storedSession) as Partial<StoredTeacherSession>;
        if (typeof parsed.teacherId !== "string" || parsed.teacherId.length === 0) {
            return null;
        }

        return parsed.teacherId;
    } catch {
        return null;
    }
}
