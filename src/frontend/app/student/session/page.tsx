import { connection } from "next/server";

import StudentSessionPage from "./student-session-page";

export default async function StudentSessionRoute() {
    await connection();

    const lessonVideoUrl =
        process.env.LESSON_VIDEO_URL ??
        "http://127.0.0.1:10000/devstoreaccount1/lesson-videos/sample.mp4";

    return <StudentSessionPage lessonVideoUrl={lessonVideoUrl} />;
}
