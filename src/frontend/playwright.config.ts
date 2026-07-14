import { defineConfig, devices } from "@playwright/test";

const frontendBaseUrl = process.env.E2E_FRONTEND_BASE_URL ?? "http://localhost:3000";
const backendBaseUrl = process.env.E2E_BACKEND_BASE_URL ?? "http://localhost:5194";
const workerHealthUrl =
    process.env.E2E_WORKER_HEALTH_URL ?? "http://localhost:8000/health";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    reporter: "list",
    globalSetup: "./e2e/global-setup.ts",
    use: {
        baseURL: frontendBaseUrl,
        trace: "on-first-retry",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    webServer: {
        command: "pnpm dev",
        url: `${frontendBaseUrl}/student`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
            NEXT_PUBLIC_API_BASE_URL: backendBaseUrl,
            NEXT_PUBLIC_BACKEND_HEALTH_URL: `${backendBaseUrl}/health/ready`,
            NEXT_PUBLIC_WORKER_HEALTH_URL: workerHealthUrl,
        },
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                permissions: ["camera"],
                launchOptions: {
                    args: [
                        "--use-fake-device-for-media-stream",
                        "--use-fake-ui-for-media-stream",
                    ],
                },
            },
        },
    ],
});
