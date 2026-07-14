# 機能別仕様書

このディレクトリには、`docs/frontend/spec.md`、`docs/backend/spec.md`、`docs/worker/spec.md` の内容を、画面・処理基盤ではなく「機能」単位で再構成した仕様書を配置する。

## 機能一覧

| 優先度 | ファイル | 機能 | 優先理由 |
| --- | --- | --- | --- |
| 01 | `01-student-session-start.md` | 受講者の学籍番号入力と受講セッション開始 | 以後の処理で使用する `sessionId` の起点となるため。 |
| 02 | `02-webcam-capture.md` | Webカメラ取得 | 映像入力がないとキャリブレーション・顔認識・送信が成立しないため。 |
| 03 | `03-video-frame-sending.md` | WebSocketによる映像フレーム送信 | バックエンドへ推論対象フレームを届けるため。 |
| 04 | `04-frame-storage-and-queue.md` | Blob保存とService Bus投入 | Workerの非同期推論パイプラインへ接続するため。 |
| 05 | `05-frame-decoding.md` | Workerによる独立JPEGフレームデコード | 顔認識の入力となる画像フレームを復元するため。 |
| 06 | `06-face-recognition.md` | 顔検出・顔ランドマーク推定 | キャリブレーションと眠気スコア算出の基礎値を得るため。 |
| 07 | `07-calibration.md` | キャリブレーション | 個人別の閉眼閾値を確定し、動画再生開始条件になるため。 |
| 08 | `08-drowsiness-scoring.md` | PERCLOSベース眠気スコア算出 | 自動停止やダッシュボード表示の中核データを生成するため。 |
| 09 | `09-realtime-notification.md` | SignalRリアルタイム通知 | 算出結果を受講者画面へ即時反映するため。 |
| 10 | `10-auto-pause-resume.md` | 動画自動停止・再開制御 | 受講完了検証の主要なユーザー体験を実現するため。 |
| 11 | `11-playback-event-recording.md` | 停止・再開イベント記録 | 自動停止・再開の履歴を後から確認できるようにするため。 |
| 12 | `12-teacher-login.md` | 管理者ログイン | 管理者向け機能へのアクセス制御に必要なため。 |
| 13 | `13-teacher-account-management.md` | 管理者による教員アカウント追加 | 教員利用者を管理するため。 |
| 14 | `14-teacher-dashboard.md` | 管理者ダッシュボード表示 | 蓄積済みデータを可視化する後段機能であるため。 |
| 15 | `15-elastic-session-frame-processing.md` | セッション単位の弾力的フレーム処理 | Session単位の順序保証を維持しつつ、Worker・Backend・Outbox・SignalRを水平スケールするため。 |

## 元仕様書

- `docs/frontend/spec.md`
- `docs/backend/spec.md`
- `docs/worker/spec.md`
