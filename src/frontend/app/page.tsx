import { connection } from "next/server";

import StudentPage from "./student/student-page";

export default async function Home() {
    await connection();

    const lessonVideoId = process.env.LESSON_VIDEO_ID ?? "default";

    return <StudentPage lessonVideoId={lessonVideoId} />;
}
