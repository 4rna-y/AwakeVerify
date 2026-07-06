export type StoredStudentSession = {
    sessionId: string;
    studentId: string;
};

export const studentSessionStorageKey = "awaver.studentSession";
export const studentSessionRoute = "/student/session";
