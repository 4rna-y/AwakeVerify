export type StoredStudentSession = {
    sessionId: string;
    calibrationCompleted?: true;
    playbackPositionSec?: number;
};

export const studentSessionStorageKey = "awaver.studentSession";
export const studentSessionRoute = "/student/session";

export function readStoredStudentSession(): StoredStudentSession | null {
    const value = sessionStorage.getItem(studentSessionStorageKey);
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as Partial<StoredStudentSession>;
        if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
            return null;
        }

        const session: StoredStudentSession = { sessionId: parsed.sessionId };
        if (parsed.calibrationCompleted === true) {
            session.calibrationCompleted = true;
        }
        if (
            typeof parsed.playbackPositionSec === "number" &&
            Number.isFinite(parsed.playbackPositionSec) &&
            parsed.playbackPositionSec >= 0
        ) {
            session.playbackPositionSec = Math.floor(parsed.playbackPositionSec);
        }

        return session;
    } catch {
        return null;
    }
}

export function writeStoredStudentSession(session: StoredStudentSession) {
    sessionStorage.setItem(studentSessionStorageKey, JSON.stringify(session));
}

export function markStoredSessionCalibrated(sessionId: string) {
    const existing = readStoredStudentSession();
    writeStoredStudentSession({
        sessionId,
        calibrationCompleted: true,
        ...(existing?.sessionId === sessionId &&
        existing.playbackPositionSec !== undefined
            ? { playbackPositionSec: existing.playbackPositionSec }
            : {}),
    });
}

export function updateStoredSessionPlaybackPosition(
    sessionId: string,
    playbackPositionSec: number,
) {
    const existing = readStoredStudentSession();
    if (existing?.sessionId !== sessionId || !Number.isFinite(playbackPositionSec)) {
        return;
    }

    writeStoredStudentSession({
        ...existing,
        playbackPositionSec: Math.max(0, Math.floor(playbackPositionSec)),
    });
}
