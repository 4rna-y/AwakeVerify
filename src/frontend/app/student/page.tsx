import { connection } from "next/server";

import StudentPage from "./student-page";

export default async function StudentRoute() {
    await connection();

    const lessonVideoId = process.env.LESSON_VIDEO_ID ?? "default";

    return <StudentPage lessonVideoId={lessonVideoId} />;
}
