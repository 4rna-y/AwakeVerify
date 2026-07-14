

const timeoutMs = 5_000;

type ServiceCheck = {
    name: string;
    url: string;
    verify?: (response: Response) => Promise<void>;
};

export default async function globalSetup() {
    const backendBaseUrl =
        process.env.E2E_BACKEND_BASE_URL ?? "http://localhost:5194";
    const checks: ServiceCheck[] = [
        {
            name: "Backend",
            url: `${backendBaseUrl}/WeatherForecast`,
        },
        {
            // The Worker only starts its health server after verifying Backend,
            // Service Bus, Blob Storage, and Redis during startup.
            name: "Worker and its required dependencies",
            url:
                process.env.E2E_WORKER_HEALTH_URL ??
                "http://localhost:8000/health",
            verify: async (response) => {
                const body = (await response.json()) as { status?: unknown };
                if (body.status !== "ok") {
                    throw new Error(`unexpected health response: ${JSON.stringify(body)}`);
                }
            },
        },
    ];

    const failures = await Promise.all(
        checks.map(async (check) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(check.url, {
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (!response.ok) {
                    return `${check.name} (${check.url}) returned HTTP ${response.status}`;
                }
                await check.verify?.(response);
                return null;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                return `${check.name} (${check.url}) is unavailable: ${detail}`;
            } finally {
                clearTimeout(timeout);
            }
        }),
    );

    const unavailable = failures.filter((failure): failure is string => failure !== null);
    if (unavailable.length > 0) {
        throw new Error(
            `E2E preflight failed. Start the devcontainer dependencies, Backend, and Worker before running the suite.\n${unavailable.join("\n")}`,
        );
    }
}
