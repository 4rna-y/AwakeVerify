# キャリブレーション失敗と再試行シナリオ

## 1. 目的

受講開始時のキャリブレーションで、有効フレーム不足により失敗した場合に、受講者へ再キャリブレーションを促し、成功するまで動画教材の再生を開始しない流れを定義する。

## 2. アクター

- 受講者
- フロントエンド
- Worker
- PostgreSQL

## 3. 前提条件

- 受講者セッションが開始済みである。
- Webカメラ映像が取得できている。
- Workerが画像フレームから顔ランドマーク推定を実行できる。

## 4. Feature path

1. [`01-student-session-start.md`](../features/01-student-session-start.md)
2. [`02-webcam-capture.md`](../features/02-webcam-capture.md)
3. [`03-video-frame-sending.md`](../features/03-video-frame-sending.md)
4. [`04-frame-storage-and-queue.md`](../features/04-frame-storage-and-queue.md)
5. [`05-frame-decoding.md`](../features/05-frame-decoding.md)
6. [`06-face-recognition.md`](../features/06-face-recognition.md)
7. [`07-calibration.md`](../features/07-calibration.md)

## 5. E2Eフロー

1. 受講者がセッションを開始する。
2. フロントエンドがWebカメラ映像を取得する。
3. フロントエンドがキャリブレーション中の案内を表示する。

   ```text
   顔を正面に向けてください。キャリブレーション中です。
   ```

4. Workerが5秒間、25フレーム相当を対象に顔検出・顔ランドマーク推定を行う。
5. Workerが各フレームについて以下を判定する。

   ```text
   顔が検出できる
   |Yaw_deg| <= 15
   |Pitch_deg| <= 15
   ```

6. 有効フレームが15フレーム未満の場合、Workerはキャリブレーション失敗と判定する。
7. フロントエンドが失敗メッセージを表示する。

   ```text
   キャリブレーションに失敗しました。顔が正面から映るようにカメラ位置を調整してください。
   ```

8. フロントエンドは動画教材の再生を禁止したままにする。
9. 受講者が顔の向きやカメラ位置を調整する。
10. フロントエンドまたはシステムが再キャリブレーションを開始する。
11. 有効フレームが15フレーム以上になった場合、Workerが `EAR_open` と `EAR_threshold` を算出する。
12. Workerが `calibrations` に結果を保存する。
13. フロントエンドが動画教材の再生を許可する。

## 6. 期待結果

- キャリブレーション失敗時、動画教材は再生開始されない。
- 受講者に顔向き・カメラ位置の調整が促される。
- 再試行後に条件を満たせばキャリブレーションが成功する。
- 成功後に初めて動画教材の再生が可能になる。

## 7. 例外・分岐

- 顔が継続的に検出できない場合は、警告表示を継続する。
- カメラ権限やデバイスが利用できない場合は、Webカメラ取得エラーとして扱う。

## 8. 関連データ

```text
calibrations
- session_id
- ear_open
- ear_threshold
- calibrated_at
```
