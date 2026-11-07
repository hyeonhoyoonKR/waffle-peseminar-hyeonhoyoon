# 첫 슬라이스: 지출을 기록하고 오늘 목록에서 확인하기

## 한 문장

지출 금액과 사용처를 입력하면 기기 안 SQLite에 저장되고, 오늘 기록 목록과 남은 예산에 바로 표시된다.

## 흐름

```mermaid
flowchart LR
  A[1. 금액 4,500원과 사용처 커피 입력] -->|오늘 지출로 기록| B[2. Expo 앱이 오늘 날짜와 지출 행을 SQLite에 저장]
  B -->|오늘 지출 합계와 목록 조회| C[(SQLite: budget_days, expenses)]
  C -->|3. 남은 예산과 오늘 기록 갱신| D[오늘 기록 화면]
```

## 예시와 화면

예산 이월 18,000원, 오늘 예산 30,000원인 날에 커피 4,500원을 기록한다. 저장 후 남은 예산은 43,500원이고, 오늘 기록 목록에는 “커피 · 4,500원”이 보인다. 같은 날 점심 11,000원도 기록하면 오늘 사용액은 15,500원, 남은 예산은 32,500원이다.

### 기기 캡처 상태

명세는 위 예시의 단계별 기기 화면과 오류 상태 화면을 요구한다. 아직 기기에서 앱이 시작되지 않아 캡처를 만들지 못했다. 화면이 실제로 캡처되기 전까지 이 제출 항목은 미완료다.

- 입력 전 화면: 미캡처
- 4,500원과 “커피” 입력 및 저장 화면: 미캡처
- 저장 결과와 남은 예산 화면: 미캡처
- 금액을 비워 저장할 때의 유효성 오류 화면: 미캡처

## 확인 방법

`mobile`에서 Node.js 20.19.4 이상으로 `npm ci` 후 `npx expo start`를 실행하고 Android Emulator 또는 Expo Go에서 위 예시를 입력한다. 같은 값을 `docs/samples/local-sqlite-response.json`의 로컬 SQLite 증빙과 대조한다.

## 실행 상태

Expo SDK 57은 Node.js 20.19.4 이상을 요구한다. 기본 `node` 18.16.0으로는 시작할 수 없었다. Node 20.20.2를 지정해 Expo를 시작했지만, Metro가 `mobile/package.json`을 읽을 때 `Unknown system error -81`이 발생했다. Android Emulator는 기동 중 “This Qt build requires the following features: neon” 오류로 종료했고, iOS CoreSimulator 서비스도 연결되지 않았다. 따라서 화면 캡처와 실제 기기 실행은 검증되지 않았다.
