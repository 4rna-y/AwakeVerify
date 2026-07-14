export const apiBaseUrl =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:5194";

export type PrincipalRole = "admin" | "teacher" | "student_session";

export type AuthPrincipal = {
    role: PrincipalRole;
    adminId?: string;
    teacherId?: string;
    studentSessionId?: string;
    principalId?: string;
    expiresAt?: string;
};

export function apiUrl(path: string) {
    return new URL(path, apiBaseUrl).toString();
}

let csrfToken: string | null = null;

export async function apiFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    const token =
        method === "GET" || method === "HEAD" || method === "OPTIONS"
            ? null
            : csrfToken ?? getCookie("awaver-csrf");

    if (token && !headers.has("X-CSRF-Token")) {
        headers.set("X-CSRF-Token", token);
    }

    const response = await fetch(apiUrl(path), {
        ...init,
        headers,
        credentials: "include",
    });
    csrfToken = response.headers.get("X-CSRF-Token") ?? csrfToken;
    return response;
}

function getCookie(name: string) {
    if (typeof document === "undefined") {
        return null;
    }

    const prefix = `${encodeURIComponent(name)}=`;
    const cookie = document.cookie
        .split("; ")
        .find((entry) => entry.startsWith(prefix));

    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
}

export async function getCurrentPrincipal() {
    const response = await apiFetch("/api/auth/me", { cache: "no-store" });

    if (!response.ok) {
        return { response, principal: null };
    }

    const payload = (await response.json()) as {
        principal?: AuthPrincipal;
    } & AuthPrincipal;

    return {
        response,
        principal: payload.principal ?? payload,
    };
}

export async function logout() {
    return apiFetch("/api/auth/logout", { method: "POST" });
}

export function isAuthenticatedResponse(payload: unknown) {
    if (typeof payload !== "object" || payload === null) {
        return false;
    }

    const value = payload as { authenticated?: unknown; success?: unknown };
    return value.authenticated === true || value.success === true;
}
