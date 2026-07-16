export type StoredStudentSession = {
    sessionId: string;
    calibrationCompleted?: true;
    playbackPositionSec?: number;
    nextFrameSequenceNo?: number;
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
        if (
            typeof parsed.nextFrameSequenceNo === "number" &&
            Number.isSafeInteger(parsed.nextFrameSequenceNo) &&
            parsed.nextFrameSequenceNo > 0
        ) {
            session.nextFrameSequenceNo = parsed.nextFrameSequenceNo;
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
        ...(existing?.sessionId === sessionId
            ? {
                  ...(existing.playbackPositionSec !== undefined
                      ? { playbackPositionSec: existing.playbackPositionSec }
                      : {}),
                  ...(existing.nextFrameSequenceNo !== undefined
                      ? { nextFrameSequenceNo: existing.nextFrameSequenceNo }
                      : {}),
              }
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

export function updateStoredSessionNextFrameSequenceNo(
    sessionId: string,
    nextFrameSequenceNo: number,
) {
    const existing = readStoredStudentSession();
    if (
        existing?.sessionId !== sessionId ||
        !Number.isSafeInteger(nextFrameSequenceNo) ||
        nextFrameSequenceNo <= 0
    ) {
        return;
    }

    writeStoredStudentSession({
        ...existing,
        nextFrameSequenceNo: Math.max(
            existing.nextFrameSequenceNo ?? 1,
            nextFrameSequenceNo,
        ),
    });
}
