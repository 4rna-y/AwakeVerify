import { expect, test } from "@playwright/test";

test.describe("受講者の通常受講シナリオ", () => {
    test("学籍番号でセッションを開始し、接続確認後にキャリブレーションを開始できる", async ({
        page,
    }) => {
        await page.goto("/student");

        await page.getByLabel("学籍番号").fill(`e2e-${Date.now()}`);
        await Promise.all([
            page.waitForURL("**/student/session"),
            page.getByRole("button", { name: "ログイン", exact: true }).click(),
        ]);

        const calibrationDialog = page.getByRole("dialog", {
            name: "キャリブレーション",
        });
        await expect(calibrationDialog).toBeVisible({ timeout: 20_000 });
        const startButton = calibrationDialog.getByRole("button", {
            name: "開始",
        });
        await expect(startButton).toBeEnabled({ timeout: 20_000 });
        await startButton.click();

        await expect(
            calibrationDialog.getByText(/^(?:[1-9]|[1-9]\d)%$/),
        ).toBeVisible({ timeout: 4_000 });

    });
});
