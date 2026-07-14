"use client";

import { useParams } from "next/navigation";

import AdminSessionPage from "./admin-session-page";

export default function AdminSessionRoute() {
    const { sessionId } = useParams<{ sessionId: string }>();

    return <AdminSessionPage sessionId={sessionId} />;
}
