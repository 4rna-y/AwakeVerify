# 最新 Azure 負荷試験レポート

実施日: 2026-07-15 (UTC)

## 対象構成

| 項目 | 設定 |
| --- | --- |
| Backend / Worker image | `improvement-20260715-1` |
| Worker replica | 最低 12、最大 15 |
| Session slot | 3 / Worker replica（最低 36 slot） |
| 試験条件 | 30 Session、60 秒、5 fps、15 秒 ramp-up、45 秒結果待機 |
| SLO | frame-to-result p95 ≤ 2 秒、p99 ≤ 5 秒、timeout = 0 |

## 3回連続試験結果

| 回 | 実施完了時刻 (UTC) | accepted frames | p50 | p95 | p99 | max | timeout | 判定 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 14:50:50 | 8,734 | 537 ms | 772 ms | 938 ms | 1,502 ms | 0 | 合格 |
| 2 | 14:53:13 | 8,754 | 555 ms | 873 ms | 1,158 ms | 2,395 ms | 0 | 合格 |
| 3 | 14:55:38 | 8,749 | 547 ms | 848 ms | 1,066 ms | 1,793 ms | 0 | 合格 |

## 集計と結論

- 3 / 3 回で SLO を達成した。
- p95: 772–873 ms（平均 831 ms）。
- p99: 938–1,158 ms（平均 1,054 ms）。
- Session 誤配送、retryable / permanent rejection、DLQ はいずれも 0。
- 各試験終了時の Service Bus Active queue と DLQ はともに 0。

この結果により、最低 12 Worker replica・最大 15 replica の構成は、上記試験条件での開始 burst に対する鮮度 SLO を満たす。
